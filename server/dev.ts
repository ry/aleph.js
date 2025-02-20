import { parseExportNames } from "https://deno.land/x/aleph_compiler@0.6.4/mod.ts";
import type { Route } from "../framework/core/route.ts";
import log from "../lib/log.ts";
import util from "../lib/util.ts";
import { initRoutes, toRouteRegExp } from "./routing.ts";
import { createFsEmitter, removeFsEmitter, watchFs } from "./watch_fs.ts";
import type { AlephConfig } from "./types.ts";

export function handleHMRSocket(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req, {});
  const emitter = createFsEmitter();
  const send = (message: Record<string, unknown>) => {
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      log.warn("socket.send:", err.message);
    }
  };
  socket.addEventListener("open", () => {
    emitter.on("create", ({ specifier }) => {
      const config: AlephConfig | undefined = Reflect.get(globalThis, "__ALEPH_CONFIG");
      if (config && config.routes) {
        const reg = toRouteRegExp(config.routes);
        const routePattern = reg.exec(specifier);
        if (routePattern) {
          send({ type: "create", specifier, routePattern });
          return;
        }
      }
      send({ type: "create", specifier });
    });
    emitter.on("remove", ({ specifier }) => {
      emitter.off(`hotUpdate:${specifier}`);
      send({ type: "remove", specifier });
    });
  });
  socket.addEventListener("message", (e) => {
    if (util.isFilledString(e.data)) {
      try {
        const { type, specifier } = JSON.parse(e.data);
        if (type === "hotAccept" && util.isFilledString(specifier)) {
          emitter.on(
            `hotUpdate:${specifier}`,
            () => send({ type: "modify", specifier }),
          );
        }
      } catch (_e) {
        log.error("invlid socket message:", e.data);
      }
    }
  });
  socket.addEventListener("close", () => {
    removeFsEmitter(emitter);
  });
  return response;
}

export function watchFS(cwd = Deno.cwd()) {
  log.info(`Watching files for changes...`);

  // update routes when fs change
  const emitter = createFsEmitter();
  const updateRoutes = async ({ specifier }: { specifier: string }) => {
    const config: AlephConfig | undefined = Reflect.get(globalThis, "__ALEPH_CONFIG");
    const rc = config?.routes;
    if (rc) {
      const reg = toRouteRegExp(rc);
      if (reg.test(specifier)) {
        const routeConfig = await initRoutes(reg);
        Reflect.set(globalThis, "__ALEPH_ROUTE_CONFIG", routeConfig);
      }
    } else {
      Reflect.set(globalThis, "__ALEPH_ROUTE_CONFIG", null);
    }
  };
  emitter.on("create", updateRoutes);
  emitter.on("remove", updateRoutes);

  watchFs(cwd);
}

/** generate the `routes.gen.ts` follow the routes config */
export async function generate(routes: Route[]) {
  const routeFiles: [fiilename: string, exportNames: string[]][] = await Promise.all(
    routes.map(async ([_, { filename }]) => {
      const code = await Deno.readTextFile(filename);
      const exportNames = await parseExportNames(filename, code);
      return [filename, exportNames];
    }),
  );

  const imports: string[] = [];
  const revives: string[] = [];

  routeFiles.forEach(([filename, exportNames], idx) => {
    if (exportNames.length === 0) {
      return [];
    }
    imports.push(
      `import { ${exportNames.map((name, i) => `${name} as ${"$".repeat(i + 1)}${idx}`).join(", ")} } from ${
        JSON.stringify(filename)
      };`,
    );
    revives.push(
      `revive(${JSON.stringify(filename)}, { ${
        exportNames.map((name, i) => `${name}: ${"$".repeat(i + 1)}${idx}`).join(", ")
      } });`,
    );
  });

  if (imports.length) {
    const code = [
      "/*! Generated by Aleph.js, do **NOT** change and ensure the file is **NOT** in the `.gitignore`. */",
      "",
      `import { revive } from "aleph/server";`,
      ...imports,
      "",
      ...revives,
    ].join("\n");
    await Deno.writeTextFile("routes.gen.ts", code);

    const serverEntry = Deno.env.get("ALEPH_SERVER_ENTRY");
    if (serverEntry) {
      const code = await Deno.readTextFile(serverEntry);
      if (!code.includes(`import "./routes.gen.ts"`)) {
        await Deno.writeTextFile(serverEntry, `import "./routes.gen.ts"\n${code}`);
      }
    }
  }
}
