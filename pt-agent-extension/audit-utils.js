globalThis.PT_AGENT_AUDIT = (() => {
  const newestFirst = (events) => {
    return (events || [])
      .map((event, index) => ({
        event,
        index,
        timestamp: Date.parse(String(event?.timestamp || ""))
      }))
      .sort((a, b) => {
        const aValid = Number.isFinite(a.timestamp);
        const bValid = Number.isFinite(b.timestamp);
        if (aValid && bValid && a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
        if (aValid !== bValid) return aValid ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ event }) => event);
  };

  return { newestFirst };
})();
