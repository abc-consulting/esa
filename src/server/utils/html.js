'use strict';

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function getTagAttribute(tag, attributeName) {
  const regex = new RegExp(`${attributeName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = tag.match(regex);
  return match ? decodeHtmlEntities(match[2]) : '';
}

function extractHiddenFields(html) {
  const fields = {};
  const inputPattern = /<input\b[^>]*>/gi;
  let match;

  while ((match = inputPattern.exec(html)) !== null) {
    const tag = match[0] || '';
    if (!/type\s*=\s*(["'])?hidden\1?/i.test(tag)) continue;

    const name = getTagAttribute(tag, 'name');
    if (!name) continue;
    const value = getTagAttribute(tag, 'value');
    fields[name] = value;
  }

  return fields;
}

function extractDataPagerTargets(html) {
  const targets = new Set();
  const decoded = decodeHtmlEntities(html);
  const postbackPattern = /__doPostBack\('([^']*DataPager[^']*)',''\)/gi;
  let match;

  while ((match = postbackPattern.exec(decoded)) !== null) {
    const target = (match[1] || '').trim();
    if (target) targets.add(target);
  }

  return Array.from(targets);
}

module.exports = {
  stripTags,
  decodeHtmlEntities,
  getTagAttribute,
  extractHiddenFields,
  extractDataPagerTargets,
};
