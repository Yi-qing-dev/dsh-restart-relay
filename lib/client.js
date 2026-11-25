/**
 * dsh-restart-guard — client banner.
 *
 * A thin strip pinned to the very top of the window, sitting on the same line
 * as the app's menu row (应用 / 编辑 / 帮助). It does not cover the page: the
 * layer is pointer-events:none and only the strip itself accepts clicks, so
 * typing and settings stay usable underneath.
 *
 * Colours follow the DSH theme and light/dark mode through --dsh-alias-*
 * variables, with a visible fallback palette when those are absent. The strip
 * is a shade off the app's own surface (slightly elevated) so it reads as part
 * of the chrome rather than as an overlay.
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_URL = '/api/restart-guard/state'
    const ACTION_URL = '/api/restart-guard/action'

    const zh = (navigator.language || '').toLowerCase().startsWith('zh')
    const copy = zh
      ? { title: 'DSH 将在', seconds: '秒后重启', now: '立即重启', later: '稍后' }
      : { title: 'DSH restarts in', seconds: 's', now: 'Restart now', later: 'Later' }

    // Follows the host: uses the DSH alias tokens when present, falls back to a
    // pair of palettes that are a touch lighter/darker than the app surface.
    //
    // `WebkitAppRegion: 'no-drag'` is load-bearing: the strip sits inside the
    // Electron title bar area, which is a drag region by default and swallows
    // clicks before they ever reach a button.
    const NO_DRAG = { WebkitAppRegion: 'no-drag' }

    const layerStyle = {
      ...NO_DRAG,
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: 'var(--dsh-frame-chrome-top, 32px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      zIndex: 2147483000,
    }

    const stripStyle = {
      ...NO_DRAG,
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      height: '24px',
      padding: '0 10px',
      borderRadius: '6px',
      background: 'var(--dsh-alias-bg-layer-1, rgba(127,127,127,0.12))',
      color: 'var(--dsh-alias-label-primary, #1c1c1e)',
      font: 'var(--dsh-content-font-size-secondary, 12px)/1 system-ui, -apple-system, "Segoe UI", sans-serif',
      border: '1px solid var(--dsh-alias-border-l1, rgba(127,127,127,0.28))',
      boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
      whiteSpace: 'nowrap',
    }

    const buttonStyle = (primary) => ({
      ...NO_DRAG,
      pointerEvents: 'auto',
      cursor: 'pointer',
      height: '18px',
      padding: '0 8px',
      borderRadius: '4px',
      font: 'inherit',
      lineHeight: '1',
      border: primary
        ? '1px solid var(--dsh-alias-state-business-primary, #3b6ef2)'
        : '1px solid var(--dsh-alias-border-l1, rgba(127,127,127,0.28))',
      background: primary ? 'var(--dsh-alias-state-business-primary, #3b6ef2)' : 'transparent',
      color: primary
        ? 'var(--dsh-alias-label-primary-inverted, #fff)'
        : 'var(--dsh-alias-label-secondary, #5a5a5f)',
    })

    function Banner(props) {
      const { onApprove, onDefer } = props
      const [state, setState] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const res = await fetch(STATE_URL, { cache: 'no-store' })
            const value = await res.json()
            if (alive) setState(value)
          } catch {
            // the host may be mid-restart; keep the last known state
          }
        }
        void tick()
        const timer = setInterval(tick, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      if (!state || state.phase !== 'counting') return null

      const remaining = Math.max(0, Math.ceil((state.remainingMs ?? 0) / 1000))

      return h(
        'div',
        { style: layerStyle },
        h(
          'div',
          { style: stripStyle, role: 'status', 'aria-live': 'polite' },
          h('span', null, `${copy.title} ${remaining} ${copy.seconds}`),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle(true),
              // pointerdown fires before any drag-region or click swallowing can
              // eat the event; onClick stays for keyboard activation.
              onPointerDown: () => onApprove(state.id),
              onClick: () => onApprove(state.id),
            },
            copy.now,
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle(false),
              onPointerDown: () => onDefer(state.id),
              onClick: () => onDefer(state.id),
            },
            copy.later,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let last = { action: '', at: 0 }
        const post = async (action) => {
          const now = Date.now()
          if (last.action === action && now - last.at < 600) return
          last = { action, at: now }
          try {
            const res = await fetch(ACTION_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action }),
            })
            console.info('[restart-guard] action', action, res.status)
          } catch (error) {
            console.warn('[restart-guard] action failed', action, error)
          }
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'restart-guard-banner',
              order: 10,
              registrant: 'dsh-restart-guard',
              inject: () => ({
                onApprove: () => void post('approve'),
                onDefer: () => void post('defer'),
              }),
            },
            Banner,
          ),
        )
      },
    }
  },
})
