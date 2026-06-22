export function flattenWithPhoneGroups(groups) {
  return (groups || []).flatMap(g => {
    const profiles = g.profiles || [];
    if (profiles.length > 1 && g.phone) {
      return profiles.map(p => ({ ...p, _phoneGroup: g.phone }));
    }
    return profiles;
  });
}

export const debounce = (callback, wait) => {
  let timeoutId = null;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      callback.apply(null, args);
    }, wait);
  };
};
