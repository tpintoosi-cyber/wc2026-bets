import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toIsraelTime } from '../services/wc2026api'

describe('toIsraelTime', () => {
  it('converts UTC to Israel time (UTC+3)', () => {
    // 2026-06-11T19:00:00.000Z → Israel 22:00
    expect(toIsraelTime('2026-06-11T19:00:00.000Z')).toBe('11/6 22:00')
  })
  it('handles midnight UTC → 03:00 Israel', () => {
    expect(toIsraelTime('2026-06-12T00:00:00.000Z')).toBe('12/6 03:00')
  })
  it('pads hours and minutes', () => {
    expect(toIsraelTime('2026-06-15T06:05:00.000Z')).toBe('15/6 09:05')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fetchGroupStageMatches — mock fetch
// ─────────────────────────────────────────────────────────────────────────────
describe('fetchGroupStageMatches (mocked)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  const mockMatches = [
    {
      id: 1, match_number: 1, round: 'group', group_name: 'A',
      home_team: 'Mexico', away_team: 'South Africa',
      stadium: 'AT&T Stadium', kickoff_utc: '2026-06-11T22:00:00.000Z',
      status: 'completed', home_score: 2, away_score: 0,
    },
    {
      id: 73, match_number: 73, round: 'knockout', group_name: null,
      home_team: 'France', away_team: 'England',
      stadium: 'MetLife', kickoff_utc: '2026-06-28T19:00:00.000Z',
      status: 'scheduled', home_score: null, away_score: null,
    },
  ]

  it('filters to group stage only', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockMatches,  // direct array
    } as any)

    const { fetchGroupStageMatches } = await import('../services/wc2026api')
    const result = await fetchGroupStageMatches()
    expect(result).toHaveLength(1)
    expect(result[0].round).toBe('group')
  })

  it('fetchKnockoutMatches returns only knockout', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockMatches,
    } as any)

    const { fetchKnockoutMatches } = await import('../services/wc2026api')
    const result = await fetchKnockoutMatches()
    expect(result).toHaveLength(1)
    expect(result[0].round).toBe('knockout')
  })

  it('handles wrapped response { data: [...] }', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockMatches }),
    } as any)

    const { fetchGroupStageMatches } = await import('../services/wc2026api')
    const result = await fetchGroupStageMatches()
    expect(result).toHaveLength(1)
  })

  it('throws on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as any)
    const { fetchGroupStageMatches } = await import('../services/wc2026api')
    await expect(fetchGroupStageMatches()).rejects.toThrow('API error: 401')
  })
})
