'use strict';

function groupProfilesByPhone(profiles) {
  const byPhone = new Map();
  const noPhone = [];
  for (const p of profiles) {
    if (p.phone) {
      if (!byPhone.has(p.phone)) byPhone.set(p.phone, []);
      byPhone.get(p.phone).push(p);
    } else {
      noPhone.push(p);
    }
  }
  const groups = [];
  for (const [phone, profs] of byPhone) groups.push({ phone, profiles: profs });
  for (const p of noPhone) groups.push({ phone: '', profiles: [p] });
  return groups;
}

module.exports = { groupProfilesByPhone };
