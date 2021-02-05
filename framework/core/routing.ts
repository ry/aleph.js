import { moduleExts } from '../../shared/constants.ts'
import util from '../../shared/util.ts'
import type { DependencyDescriptor, RouterURL } from '../../types.ts'
import events from './events.ts'

const ghostRoute: Route = { path: '', module: { url: '', hash: '' } }

export type Route = {
  path: string
  module: RouteModule
  children?: Route[]
}

export type RouteModule = {
  readonly url: string
  readonly hash: string
  readonly asyncDeps?: DependencyDescriptor[]
}

export type RoutingOptions = {
  routes?: Route[]
  rewrites?: Record<string, string>
  baseUrl?: string
  defaultLocale?: string
  locales?: string[]
}

export class Routing {
  private _baseUrl: string
  private _defaultLocale: string
  private _locales: string[]
  private _routes: Route[]
  private _rewrites: Record<string, string>

  constructor({
    baseUrl = '/',
    defaultLocale = 'en',
    locales = [],
    routes = [],
    rewrites = {},
  }: RoutingOptions) {
    this._baseUrl = baseUrl
    this._defaultLocale = defaultLocale
    this._locales = locales
    this._routes = routes
    this._rewrites = rewrites
  }

  get baseUrl() {
    return this._baseUrl
  }

  get paths() {
    const paths: string[] = []
    this._lookup(path => { paths.push(path.map(r => r.path).join('')) }, true)
    return paths
  }

  // routes returns the routes as copy
  get routes(): Route[] {
    return JSON.parse(JSON.stringify(this._routes))
  }

  update(module: RouteModule) {
    const newRoute: Route = { path: toPagePath(module.url), module }
    const dirtyRoutes: Set<Route[]> = new Set()
    let exists = false
    let targetRoutes = this._routes
    this._lookup(routePath => {
      const path = routePath.map(r => r.path).join('')
      const route = routePath[routePath.length - 1]
      const parentRoute = routePath[routePath.length - 2]
      if (route.module.url === module.url) {
        Object.assign(route.module, module)
        exists = true
        return false
      }
      if (!newRoute.path.endsWith('/') && path.startsWith(newRoute.path + '/')) {
        const routes = parentRoute ? parentRoute.children! : this._routes
        const index = routes.indexOf(route)
        if (index >= 0) {
          routes.splice(index, 1, ghostRoute)
          dirtyRoutes.add(routes)
        }
        (newRoute.children || (newRoute.children = [])).push({ ...route, path: util.trimPrefix(path, newRoute.path) })
      } else if (!path.endsWith('/') && newRoute.path.startsWith(path + '/')) {
        newRoute.path = util.trimPrefix(newRoute.path, path)
        targetRoutes = route.children || (route.children = [])
      }
    })
    if (exists) {
      return
    }
    dirtyRoutes.forEach(routes => {
      let index: number
      while (~(index = routes.indexOf(ghostRoute))) {
        routes.splice(index, 1)
      }
    })
    dirtyRoutes.clear()
    targetRoutes.push(newRoute)
  }

  removeRoute(url: string) {
    this._lookup(path => {
      const route = path[path.length - 1]
      if (route.module.url === url) {
        const parentRoute = path[path.length - 2]
        const routes = parentRoute ? parentRoute.children! : this._routes
        const index = routes.indexOf(route)
        if (index >= 0) {
          routes.splice(index, 1, ...(route.children || []).map(r => ({ ...r, path: route.path + r.path })))
        }
        return false
      }
    })
  }

  createRouter(location?: { pathname: string, search?: string }): [RouterURL, RouteModule[]] {
    const loc = location || (window as any).location || { pathname: '/' }
    const url = rewriteURL(loc.pathname + (loc.search || ''), this._baseUrl, this._rewrites)

    let locale = this._defaultLocale
    let pathname = decodeURI(url.pathname)
    let pagePath = ''
    let params: Record<string, string> = {}
    let chain: RouteModule[] = []

    if (pathname !== '/' && this._locales.length > 0) {
      const a = pathname.split('/')
      const a1 = a[1]
      if (a1 !== locale && this._locales.includes(a1)) {
        locale = a1
        pathname = '/' + a.slice(2).join('/')
      }
    }

    this._lookup(routePath => {
      const path = routePath.map(r => r.path).join('')
      const [p, ok] = matchPath(path, pathname)
      if (ok) {
        chain = routePath.map(r => r.module)
        const c = routePath[routePath.length - 1].children?.find(c => c.path === '/')
        if (c) {
          chain.push(c.module)
        }
        pagePath = path
        params = p
        return false
      }
    }, true)

    return [{ locale, pathname, pagePath, params, query: url.searchParams }, chain]
  }

  lookup(callback: (path: Route[]) => Boolean | void) {
    this._lookup(callback)
  }

  private _lookup(
    callback: (path: Route[]) => Boolean | void,
    skipNestIndex = false,
    _tracing: Route[] = [],
    _routes = this._routes
  ) {
    for (const route of _routes) {
      if (skipNestIndex && _tracing.length > 0 && route.path === '/') {
        continue
      }
      if (callback([..._tracing, route]) === false) {
        return false
      }
    }
    for (const route of _routes) {
      if (route.path !== '/' && route.children?.length) {
        if (this._lookup(callback, skipNestIndex, [..._tracing, route], route.children) === false) {
          return false
        }
      }
    }
  }
}

function matchPath(routePath: string, locPath: string): [Record<string, string>, boolean] {
  const params: Record<string, string> = {}
  const routeSegments = util.splitPath(routePath)
  const locSegments = util.splitPath(locPath)
  const depth = Math.max(routeSegments.length, locSegments.length)

  for (let i = 0; i < depth; i++) {
    const routeSeg = routeSegments[i]
    const locSeg = locSegments[i]

    if (locSeg === undefined || routeSeg === undefined) {
      return [{}, false]
    }

    if (routeSeg.startsWith('[...') && routeSeg.endsWith(']') && routeSeg.length > 5 && i === routeSegments.length - 1) {
      params[routeSeg.slice(4, -1)] = locSegments.slice(i).map(decodeURIComponent).join('/')
      break
    }

    if (routeSeg.startsWith('[') && routeSeg.endsWith(']') && routeSeg.length > 2) {
      params[routeSeg.slice(1, -1)] = decodeURIComponent(locSeg)
    } else if (routeSeg.startsWith('$') && routeSeg.length > 1) {
      params[routeSeg.slice(1)] = decodeURIComponent(locSeg)
    } else if (routeSeg !== locSeg) {
      return [{}, false]
    }
  }

  return [params, true]
}

/** `rewriteURL` returns a rewrited URL */
export function rewriteURL(reqUrl: string, baseUrl: string, rewrites: Record<string, string>): URL {
  const url = new URL('http://localhost' + reqUrl)
  if (baseUrl !== '/') {
    url.pathname = util.trimPrefix(decodeURI(url.pathname), baseUrl)
  }
  for (const path in rewrites) {
    const to = rewrites[path]
    const [params, ok] = matchPath(path, decodeURI(url.pathname))
    if (ok) {
      const { searchParams } = url
      url.href = 'http://localhost' + util.cleanPath(to.replace(/:(.+)(\/|&|$)/g, (s, k, e) => {
        if (k in params) {
          return params[k] + e
        }
        return s
      }))
      for (const [key, value] of url.searchParams.entries()) {
        searchParams.append(key, value)
      }
      url.search = searchParams.toString()
      break
    }
  }
  return url
}

export async function redirect(url: string, replace?: boolean) {
  const { location, history } = window as any

  if (!util.isNEString(url)) {
    return
  }

  if (util.isLikelyHttpURL(url) || url.startsWith('file://') || url.startsWith('mailto:')) {
    location.href = url
    return
  }

  url = util.cleanPath(url)
  if (replace) {
    history.replaceState(null, '', url)
  } else {
    history.pushState(null, '', url)
  }
  events.emit('popstate', { type: 'popstate', resetScroll: true })
}

export function isModuleURL(url: string) {
  for (const ext of moduleExts) {
    if (url.endsWith('.' + ext)) {
      return true
    }
  }
  return false
}

export function toPagePath(url: string): string {
  let pathname = util.trimModuleExt(url)
  if (pathname.startsWith('/pages/')) {
    pathname = util.trimPrefix(pathname, '/pages')
  }
  if (pathname.endsWith('/index')) {
    pathname = util.trimSuffix(pathname, 'index')
  }
  if (pathname === '') {
    pathname = '/'
  }
  return pathname
}