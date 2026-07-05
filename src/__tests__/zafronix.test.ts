import { describe, it, expect } from 'vitest'
import { getRegulationScore, type ZafronixMatch } from '../services/zafronix'

const mk = (homeScore: number, awayScore: number, goals: { minute: number; team: 'home' | 'away' }[]): ZafronixMatch => ({
  id: 'x', matchNo: 1, homeTeam: 'A', awayTeam: 'B',
  homeScore, awayScore, status: 'finished',
  goals: goals.map(g => ({ ...g, scorer: 'x' })),
})

describe('getRegulationScore', () => {
  it('strips extra-time goals — real #86 case (Argentina vs Cabo Verde)', () => {
    // goals 29,59 in regulation; 92,103,111 in extra time. Final 3-2, 90-min 1-1.
    const m = mk(3, 2, [
      { minute: 29, team: 'home' },
      { minute: 59, team: 'away' },
      { minute: 92, team: 'home' },
      { minute: 103, team: 'away' },
      { minute: 111, team: 'home' },
    ])
    expect(getRegulationScore(m)).toEqual({ home: 1, away: 1 })
  })

  it('regulation match — 90-min equals final', () => {
    const m = mk(3, 0, [
      { minute: 17, team: 'home' },
      { minute: 60, team: 'home' },
      { minute: 76, team: 'home' },
    ])
    expect(getRegulationScore(m)).toEqual({ home: 3, away: 0 })
  })

  it('counts a 90th-minute goal as regulation', () => {
    const m = mk(2, 0, [
      { minute: 38, team: 'home' },
      { minute: 90, team: 'home' },
    ])
    expect(getRegulationScore(m)).toEqual({ home: 2, away: 0 })
  })

  it('returns 0-0 when there are no goals and final is 0-0', () => {
    const m: ZafronixMatch = { id: 'x', matchNo: 1, homeTeam: 'A', awayTeam: 'B', homeScore: 0, awayScore: 0, status: 'finished', goals: [] }
    expect(getRegulationScore(m)).toEqual({ home: 0, away: 0 })
  })

  it('returns null when goals do not reconcile with the final score (missing/own-goal)', () => {
    // Final says 3-2 but only 2 home goals present → untrustworthy, keep existing value.
    const m = mk(3, 2, [
      { minute: 29, team: 'home' },
      { minute: 59, team: 'away' },
      { minute: 103, team: 'away' },
    ])
    expect(getRegulationScore(m)).toBeNull()
  })
})
