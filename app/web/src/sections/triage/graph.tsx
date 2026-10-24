/**
 * Triage → Graph: entered from a Triage session the way analytics is from Sessions —
 * full width, the opthub session-graph page for that session in a frame.
 */
import { useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { MidHead } from '@/components/hub'
import { useHub, type Theme } from '@/store'

/* the graph page follows the Hub's theme switch, not only the OS: it knows light and dark, so black reads as dark */
function graphTheme(frame: HTMLIFrameElement | null, t: Theme) {
  try {
    const r = frame?.contentDocument?.documentElement
    if (!r) return
    if (t === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', t === 'black' ? 'dark' : t)
  } catch { /* a cross-origin or error page: leave it be */ }
}

export function GraphView() {
  const sid = useHub((h) => h.graphSid), theme = useHub((h) => h.theme), tri = useHub((h) => h.tri)
  const frame = useRef<HTMLIFrameElement>(null)
  const s = tri?.sessions.find((x) => x.session === sid)
  const src = '/triage/' + encodeURIComponent(sid) + '/graph'
  const onLoad = useCallback(() => graphTheme(frame.current, useHub.getState().theme), [])
  useEffect(() => graphTheme(frame.current, theme), [theme])
  return (
    <>
      <MidHead title="Graph" crumb={(s ? s.project + ' · ' : '') + 'session ' + sid.slice(0, 8)}>
        <Button variant="outline" size="xs" className="font-mono text-[11px] text-muted-foreground" onClick={() => useHub.setState({ section: 'triage' })}>◂ triage</Button>
        <a className="text-[11.5px] text-muted-foreground hover:text-foreground" href={src} target="_blank">open in a tab ▸</a>
      </MidHead>
      {/* keyed by session, so the poll's re-renders never reload the frame and lose its state */}
      <iframe key={sid} ref={frame} src={src + '#embed'} onLoad={onLoad} title={'session graph ' + sid.slice(0, 8)}
        className="mt-2 block h-[calc(100vh-120px)] w-full rounded-lg border bg-black" />
    </>
  )
}
