import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Limit, Snapshot } from '../types'

// 경고 임계값 (%). 각 윈도우가 처음 넘을 때 한 번씩만 알린다.
const WARN = 80
const CRITICAL = 95

const LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: '지출',
}

const snapshot = atom({ plugin: 'usage-line', key: 'snapshot' } as const, null)
const isEnabled = atom({ plugin: 'usage-line', key: 'isEnabled' } as const, true)

// 한 윈도우(kind+resetsAt)마다 이미 알린 임계값. 리셋되면 키가 바뀌어 다시 알린다.
const warned = new Map<string, number>()

export const remaining = (resetsAt: string | undefined, now: number): string => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const min = Math.floor(ms / 60_000)
  const h = Math.floor(min / 60)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}일 ${h % 24}h`
  if (h >= 1) return `${h}h ${min % 60}m`
  return `${min}m`
}

// 'claude-opus-5-5' -> 'opus-5-5'. 별칭('opus')은 그대로 둔다.
export const modelLabel = (model: string | undefined): string => (model ?? '').trim().replace(/^claude-/, '')

type Role = 'model' | 'limit' | 'context' | 'cost' | 'none'
// 0: 여유, 1: WARN 이상, 2: CRITICAL 이상
type Level = 0 | 1 | 2
export type Segment = { text: string; role: Role; level: Level }

const levelOf = (percent: number): Level => (percent >= CRITICAL ? 2 : percent >= WARN ? 1 : 0)

export const segments = (s: Snapshot, now: number): Segment[] => {
  const parts: Segment[] = []
  const model = modelLabel(s.model)
  if (model) parts.push({ text: model, role: 'model', level: 0 })
  for (const w of s.rateLimits) {
    const label = LABEL[w.kind] ?? w.kind
    const pct = Math.round(w.percentUsed)
    const level = levelOf(w.percentUsed)
    const left = remaining(w.resetsAt, now)
    const text = `${label} ${pct}%${'!'.repeat(level)}${left ? ` (리셋 ${left})` : ''}`
    parts.push({ text, role: 'limit', level })
  }
  if (s.rateLimits.length === 0) parts.push({ text: '한도 미확인', role: 'none', level: 0 })
  if (s.context.percent !== undefined) {
    parts.push({ text: `ctx ${s.context.percent}%`, role: 'context', level: levelOf(s.context.percent) })
  }
  if (s.cost) parts.push({ text: `$${s.cost.usd.toFixed(2)}`, role: 'cost', level: 0 })
  return parts
}

export const format = (s: Snapshot, now: number): string =>
  segments(s, now)
    .map(p => p.text)
    .join(' · ')

// 색 프리셋. userConfig 의 colors 로 고른다.
export const PRESETS = ['auto', 'vivid', 'mono', 'theme'] as const
export type Preset = (typeof PRESETS)[number]
type Style = { color?: Color; dimColor?: boolean; bold?: boolean }

const AUTO_LEVEL: readonly Color[] = ['success', 'warning', 'error']
const VIVID_LEVEL: readonly Color[] = ['green', 'yellow', 'red']

export const styleOf = (preset: Preset, p: Segment): Style => {
  if (preset === 'mono') return p.level > 0 ? { bold: true } : { dimColor: true }
  if (preset === 'theme') return { color: 'claude', bold: p.level > 0 }
  const byLevel = preset === 'vivid' ? VIVID_LEVEL : AUTO_LEVEL
  const hot = p.level > 0 ? { color: byLevel[p.level], bold: p.level === 2 } : undefined
  switch (p.role) {
    case 'model':
      return { color: preset === 'vivid' ? 'cyan' : 'claude', bold: true }
    case 'limit':
      return { color: byLevel[p.level], bold: p.level === 2 }
    case 'context':
      return hot ?? (preset === 'vivid' ? { color: 'magenta' } : { color: 'text' })
    case 'cost':
      return preset === 'vivid' ? { color: 'blue' } : { color: 'suggestion' }
    default:
      return { dimColor: true }
  }
}

const presetOf = (value: unknown): Preset => PRESETS.find(p => p === value) ?? 'auto'

// 모델은 측정값에 실려 오지 않으므로 저장할 때마다 묻는다. 못 읽으면 모델 없이 그린다.
const withModel = async ($: EngineInterface, s: Snapshot): Promise<Snapshot> => ({
  context: { percent: s.context.percent },
  rateLimits: s.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
  cost: s.cost && { usd: s.cost.usd },
  model: await $.session.model().catch(() => undefined),
})

// 띠는 snapshot 을 읽어 그리므로, 써 두기만 하면 다시 그려진다.
async function save($: EngineInterface, s: Snapshot): Promise<Snapshot> {
  const next = await withModel($, s)
  await update($, snapshot, () => next)
  return next
}

async function warn($: EngineInterface, limits: readonly Limit[]): Promise<void> {
  for (const w of limits) {
    const key = `${w.kind}@${w.resetsAt ?? ''}`
    const level = w.percentUsed >= CRITICAL ? CRITICAL : w.percentUsed >= WARN ? WARN : 0
    if (level === 0 || (warned.get(key) ?? 0) >= level) continue
    warned.set(key, level)
    const label = LABEL[w.kind] ?? w.kind
    const left = remaining(w.resetsAt, await $.clock.now())
    const text = `${label} 한도 ${Math.round(w.percentUsed)}% 사용${left ? `, ${left} 후 리셋` : ''}`
    $.ui.toast(text, { timeoutMs: level === CRITICAL ? 10_000 : 6_000 })
    if (level === CRITICAL) void $.ui.notify(text, { title: '사용량 경고' }).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  const preset = presetOf(options.colors)

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('enabled')
    await update($, isEnabled, () => stored !== false)
    // 프롬프트 아래 상태줄에 그리던 이전 버전의 줄을 지운다.
    $.ui.status(undefined)
    await $.command.register({
      name: 'usage-line',
      description: '프롬프트 위의 사용량 표시를 켜거나 끈다 (on/off, 비우면 토글)',
      argumentHint: 'on|off',
    })
    void $.session.usage().then(u => save($, u)).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await save($, e)
    await warn($, e.rateLimits)
    return next(e)
  })

  // /model 로 바꾼 모델은 측정을 일으키지 않으므로, 다음 턴이 시작될 때 다시 읽는다.
  on('turn.start', ($, e, next) => {
    void $.session.usage().then(u => save($, u)).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null || !(await read($, isEnabled))) return next(e)

    const { Text } = $.ui.resolve(e)
    const parts = segments(s, await $.clock.now())

    return (
      <Text wrap="truncate-end">
        {parts.map((p, i) => (
          <Text {...styleOf(preset, p)}>
            {i > 0 ? ' · ' : ''}
            {p.text}
          </Text>
        ))}
      </Text>
    )
  })

  on('command.run', { command: 'usage-line' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const was = await read($, isEnabled)
    const enabled = arg === 'on' ? true : arg === 'off' ? false : !was
    await update($, isEnabled, () => enabled)
    await $.store.set('enabled', enabled)
    const u = await save($, await $.session.usage())
    return { text: enabled ? `사용량 표시 켜짐: ${format(u, await $.clock.now())}` : '사용량 표시 꺼짐' }
  })
}
