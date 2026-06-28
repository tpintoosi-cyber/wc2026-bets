// Read current scores before computing new ones (for delta tracking)
const currentScoresSnap = await getDocs(collection(db, 'scores'))
const currentTotals: Record<string, number> = {}
const currentRanks: Record<string, number> = {}
const currentUserNames: Record<string, string> = {}   // ← הוסף שורה זו
const sortedCurrent = currentScoresSnap.docs
  .map(d => ({ userId: d.id, total: (d.data().total ?? 0) as number,
    prevTotal: d.data().prevTotal as number | undefined,
    prevRank:  d.data().prevRank  as number | undefined,
    userName:  d.data().userName  as string | undefined }))   // ← הוסף userName
  .sort((a, b) => b.total - a.total)
sortedCurrent.forEach((s, i) => {
  currentTotals[s.userId] = s.total
  currentRanks[s.userId] = i + 1
  if (s.userName) currentUserNames[s.userId] = s.userName   // ← הוסף שורה זו
})
