'use strict';

function flattenWithSameNumber(profiles) {
  const byPhone = new Map();
  for (const p of profiles) {
    if (p.phone) {
      if (!byPhone.has(p.phone)) byPhone.set(p.phone, []);
      byPhone.get(p.phone).push(p);
    }
  }
  return profiles.map(p => {
    const peers = p.phone ? byPhone.get(p.phone).filter(q => q !== p) : [];
    return {
      ...p,
      profiles_with_same_number: peers.map(q => ({ uid: q.uid, provider: q.provider })),
    };
  });
}

module.exports = { flattenWithSameNumber };
