import { test, expect, mock } from 'claude-code/testing'
import { format, modelLabel, remaining, segments, styleOf } from '../hooks/register'

const T0 = Date.parse('2026-10-09T10:00:00Z')

const BAND = {
  plugin: 'usage-line',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// 띠의 한 항목: 그 글자를 보여주는 가장 안쪽 Text.
const part = async (ui: { findAll: (q: { type: string; text: RegExp }) => Promise<{ text: string; props: Record<string, unknown> }[]> }, text: RegExp) =>
  (await ui.findAll({ type: 'Text', text })).at(-1)

test('format: 두 윈도우와 컨텍스트, 비용을 한 줄로 그린다', () => {
  const line = format(
    {
      context: { percent: 32 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 63.4, resetsAt: '2026-10-09T12:10:00Z' },
        { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-12T14:00:00Z' },
      ],
      cost: { usd: 12.345 },
    },
    T0,
  )
  expect(line).toBe('5h 63% (리셋 2h 10m) · 7d 41% (리셋 3일 4h) · ctx 32% · $12.35')
})

test('format: 한도 정보가 없으면 그렇다고 말한다', () => {
  expect(format({ context: {}, rateLimits: [] }, T0)).toBe('한도 미확인')
})

test('format: 80% 이상은 !, 95% 이상은 !! 표식이 붙는다', () => {
  const at = (p: number) => format({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: p }] }, T0)
  expect(at(79.9)).toBe('5h 80%')
  expect(at(85)).toBe('5h 85%!')
  expect(at(96)).toBe('5h 96%!!')
})

test('remaining: 지난 시각이나 없는 값은 빈 문자열', () => {
  expect(remaining(undefined, T0)).toBe('')
  expect(remaining('2026-10-09T09:00:00Z', T0)).toBe('')
  expect(remaining('2026-10-09T10:25:00Z', T0)).toBe('25m')
})

test('format: 모델이 있으면 맨 앞에 붙고 claude- 접두사는 뗀다', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('opus-5-5')
  expect(modelLabel('opus')).toBe('opus')
  expect(modelLabel(undefined)).toBe('')
  const line = format({ context: { percent: 5 }, rateLimits: [], model: 'claude-opus-5-5' }, T0)
  expect(line).toBe('opus-5-5 · 한도 미확인 · ctx 5%')
})

test('styleOf: 프리셋마다 항목과 사용률 단계에 맞는 색을 고른다', () => {
  const at = (p: number) => segments({ context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: p }] }, T0)[0]!
  expect(styleOf('auto', at(50)).color).toBe('success')
  expect(styleOf('auto', at(85)).color).toBe('warning')
  expect(styleOf('auto', at(96))).toEqual({ color: 'error', bold: true })
  expect(styleOf('vivid', at(50)).color).toBe('green')
  expect(styleOf('vivid', at(96)).color).toBe('red')
  expect(styleOf('mono', at(50))).toEqual({ dimColor: true })
  expect(styleOf('mono', at(85))).toEqual({ bold: true })
  expect(styleOf('theme', at(50)).color).toBe('claude')
})

test('session.measure 가 80% 를 넘으면 한 번만 토스트한다', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'disabled' as const } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  const measure = (p: number) =>
    $.session.measure({
      context: { window: 200_000, tokens: 20_000, percent: 10 },
      rateLimits: [{ kind: 'five_hour', percentUsed: p, resetsAt: '2026-10-09T13:00:00Z' }],
      cost: { usd: 1 },
      changed: ['rateLimits'],
    })

  await measure(50)
  expect(toasts).toEqual([])
  await measure(82)
  await measure(84)
  expect(toasts).toEqual(['5h 한도 82% 사용, 3h 0m 후 리셋'])
  await measure(97)
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toBe('5h 한도 97% 사용, 3h 0m 후 리셋')
})

test('프롬프트 위 띠가 모델과 사용량을 색으로 그리고, 모델이 바뀌면 따라간다', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  let model = 'claude-opus-5-5'
  on('session.model', () => ({ value: model }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  const measure = (p: number) =>
    $.session.measure({
      context: { window: 200_000, tokens: 20_000, percent: 10 },
      rateLimits: [{ kind: 'five_hour', percentUsed: p, resetsAt: '2026-10-09T13:00:00Z' }],
      cost: { usd: 1 },
      changed: ['rateLimits'],
    })

  await measure(50)
  const ui = await $.ui.mount(BAND)
  expect((await part(ui, /opus|sonnet/))?.text).toBe('opus-5-5')
  expect((await part(ui, /opus|sonnet/))?.props.color).toBe('claude')
  expect((await part(ui, /5h/))?.text).toBe(' · 5h 50% (리셋 3h 0m)')
  expect((await part(ui, /5h/))?.props.color).toBe('success')
  expect((await part(ui, /ctx/))?.text).toBe(' · ctx 10%')
  expect((await part(ui, /\$/))?.text).toBe(' · $1.00')
  expect((await part(ui, /\$/))?.props.color).toBe('suggestion')

  model = 'claude-sonnet-5-5'
  await measure(85)
  expect((await part(ui, /opus|sonnet/))?.text).toBe('sonnet-5-5')
  expect((await part(ui, /5h/))?.props.color).toBe('warning')
  await ui.unmount()
})

test('colors 옵션이 vivid 면 원색으로 그린다', { options: { colors: 'vivid' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000, tokens: 20_000, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 50 }],
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount(BAND)
  expect((await part(ui, /opus|sonnet/))?.props.color).toBe('cyan')
  expect((await part(ui, /5h/))?.props.color).toBe('green')
  expect((await part(ui, /ctx/))?.props.color).toBe('magenta')
  await ui.unmount()
})

test('설문이 띠를 쓰는 동안이나 측정 전에는 엔진의 것을 그대로 둔다', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))

  const before = await $.ui.mount(BAND)
  expect(await before.drawn()).toMatchObject({ children: ['engine'] })
  await before.unmount()

  await $.session.measure({ context: { window: 1, percent: 10 }, rateLimits: [], changed: ['context'] })
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.drawn()).toMatchObject({ children: ['engine'] })
  await survey.unmount()
})
