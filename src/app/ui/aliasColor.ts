export function aliasColor(alias: string): string {
  let h = 0
  for (let i = 0; i < alias.length; i++) h = (h * 31 + alias.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 14% 22%)`
}