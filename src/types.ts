export type Category = 'A' | 'B' | 'C' | 'D'
export type Result1X2 = '1' | 'X' | '2'
export type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L'
export type KnockoutRound = 'R32' | 'R16' | 'QF' | 'SF' | '3P' | 'F'

export interface Match {
  id: number
  group: Group
  round: 1 | 2 | 3
  teamA: string
  teamB: string
  category: Category
  fifaPointsA: number
  fifaPointsB: number
  // Filled by admin
  resultA?: number
  resultB?: number
  hadRedCard?: boolean
  isPlayed?: boolean
}

export interface KnockoutMatch {
  id: number           // 73–104
  round: KnockoutRound
  category: Category
  fifaPointsA: number
  fifaPointsB: number
  teamA?: string       // set by admin after group stage
  teamB?: string
  // Admin results
  resultA?: number     // score at 90 min
  resultB?: number
  advanceTeam?: string // who actually advanced (could be different from winner at 90min)
  hadRedCard?: boolean // R32 + R16 only
  isPlayed?: boolean
}

export interface MatchPrediction {
  matchId: number
  prediction1X2: Result1X2
  scoreA: number
  scoreB: number
  redCard: boolean
}

// R32: user fills 1X2 + score + advance + redCard
// R16+: user fills 1X2 + score (+ redCard for R16), advance comes from R32
export interface KnockoutMatchPrediction {
  matchId: number
  prediction1X2: Result1X2
  scoreA: number | null
  scoreB: number | null
  redCard?: boolean      // R32 + R16 only
  advance?: string       // R32 only: which team advances
}

export interface GroupPrediction {
  group: Group
  advancing: [string, string, string]
}

export interface BonusPredictions {
  q105: string  // World champion
  q106: string  // Runner-up
  q107: string  // Third place
  q108: string  // Top scorer (player name)
  q109: string  // How many goals by top scorer
  q110: string  // Top assist (player name)
  q111: string  // Best team group stage
  q112: string  // Worst team group stage
  q113: string  // Group with most goals (A-L)
  q114: string  // Group with fewest goals (A-L)
  q115: string  // Best defense group stage
  q116: string  // How many penalty shootouts in knockout
  q117: string  // Total red cards in tournament
}

export interface UserPredictions {
  userId: string
  userName: string
  submittedAt?: number
  isLocked: boolean
  matches: Record<number, MatchPrediction>
  groups: Record<Group, GroupPrediction>
  bonus: Partial<BonusPredictions>
  knockout?: Record<number, KnockoutMatchPrediction>
}

export interface MatchScore {
  matchId: number
  points1X2: number
  pointsScore: number
  pointsRedCard: number
  total: number
}

export interface GroupScore {
  group: Group
  points: number
}

export interface UserScore {
  userId: string
  userName: string
  total: number
  matchPoints: number
  groupPoints: number
  bonusPoints: number
  redCardPoints: number
  knockoutPoints: number
  matchDetails: Record<number, MatchScore>
  lastUpdated: number
}

export interface AppSettings {
  deadline: number   // timestamp ms
  isOpen: boolean
  adminUids: string[]
  knockoutOpen?: boolean          // window open for R32 predictions
  knockoutDeadline?: number
}
