/**
 * Minimal glob support for `patina.exclude`, with VS Code-style semantics: patterns are relative to the
 * workspace folder, `*` and `?` stay within one path segment, `**` spans segments, `{a,b}` alternates and
 * `[...]` is a character class. A pattern matching a folder also excludes everything inside it.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  let inBraces = false;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        const atEnd = i + 2 === g.length || g[i + 2] === '/';
        if (atStart && atEnd) {
          if (g[i + 2] === '/') {
            re += '(?:.*/)?'; // "**/" — zero or more leading segments
            i += 2;
          } else {
            re += '.*'; // trailing "**"
            i += 1;
          }
          continue;
        }
        re += '[^/]*'; // "**" inside a segment behaves like "*"
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      inBraces = true;
      re += '(?:';
    } else if (ch === '}' && inBraces) {
      inBraces = false;
      re += ')';
    } else if (ch === ',' && inBraces) {
      re += '|';
    } else if (ch === '[') {
      const close = g.indexOf(']', i + 1);
      if (close > i + 1) {
        let cls = g.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = close;
      } else {
        re += '\\[';
      }
    } else {
      re += ch.replace(/[.+^$()|\\\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Compiles patterns into a predicate over workspace-relative paths (forward slashes). A path is excluded if
 * it, or any folder containing it, matches a pattern. Empty or blank patterns are ignored.
 */
export function compileExcludes(patterns: readonly string[]): (relPath: string) => boolean {
  const regexes = patterns.filter((p) => typeof p === 'string' && p.trim()).map(globToRegExp);
  if (!regexes.length) return () => false;
  return (relPath) => {
    const parts = relPath.split('/');
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (regexes.some((r) => r.test(prefix))) return true;
    }
    return false;
  };
}
