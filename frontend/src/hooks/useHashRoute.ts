import { useCallback, useEffect, useState } from 'react'

export type Route = 'dashboard' | 'field' | 'terrain' | 'ops'

const ROUTES: Route[] = ['dashboard', 'field', 'terrain', 'ops']

function parse(hash: string): Route {
  // 容错：hash 里可能带查询串（如 #/field?v=1）或多余斜杠，都要能正确解析
  const name = hash.replace(/^#\/?/, '').split('?')[0].replace(/\/+$/, '') as Route
  return ROUTES.includes(name) ? name : 'dashboard'
}

/** 极简 hash 路由：两个页面（算法预警大屏 / 现场监测），刷新后仍停在同一页。

    没有引入 react-router：只有两个页面，20 行足够，也少一个依赖。
*/
export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof location === 'undefined' ? 'dashboard' : parse(location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((next: Route) => {
    location.hash = `#/${next}`
    setRoute(next)
  }, [])

  return [route, navigate]
}
