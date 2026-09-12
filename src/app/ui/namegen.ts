// ── Anonymous name generator ─────────────────────────────────────
const ADJECTIVES = [
  'amber','arctic','ashen','blank','cipher','cold','dark','delta','dim','echo',
  'empty','faint','ghost','glass','hollow','iron','jade','lunar','mist','null',
  'obsidian','pale','phantom','quiet','raven','shade','silent','slate','smoke',
  'still','storm','thorn','void','wane','zero'
]
const NOUNS = [
  'axis','bridge','cardinal','cliff','coast','core','crest','drift','dusk','edge',
  'ember','field','flare','fog','gate','haven','haze','hive','hour','isle','knot',
  'lake','lark','line','lock','mark','mesh','moon','node','peak','prism','ridge',
  'rift','ring','seal','shade','shift','shore','sill','span','spark','vale'
]

export function generateAlias(): string {
  const seed = crypto.getRandomValues(new Uint32Array(2))
  const adj = ADJECTIVES[seed[0] % ADJECTIVES.length]
  const noun = NOUNS[seed[1] % NOUNS.length]
  const suffix = (seed[0] >> 16) % 100
  return `${adj}-${noun}-${suffix.toString().padStart(2, '0')}`
}