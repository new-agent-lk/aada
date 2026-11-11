// Name de-duplication for file paste/upload, kept dependency-free so
// script/selftest.mjs can exercise it.

export interface NamedEntry {
  name: string
}

// Returns a name that does not collide with any entry, appending " (n)" before
// the extension (name (1).ext, name (2).ext, ...) so a paste never silently
// overwrites an existing file.
export function uniqueName(entries: NamedEntry[], name: string): string {
  const taken = (n: string) => entries.some((entry) => entry.name === n)
  if (!taken(name)) {
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 1
  while (taken(`${base} (${i})${ext}`)) {
    i++
  }
  return `${base} (${i})${ext}`
}
