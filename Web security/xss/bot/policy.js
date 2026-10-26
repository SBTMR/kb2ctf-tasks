export function origin(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid configured origin');
  return parsed.origin;
}

export function runner(visit) {
  let active = false;
  return async () => {
    if (active) return false;
    active = true;
    try { await visit(); return true; }
    finally { active = false; }
  };
}
