'use strict';

const fs = require('fs');
const path = require('path');
const { MIME_TYPES, ROOT } = require('../constants');
const { send } = require('../utils/http');

function handleStatic(req, res, serverBase) {
  const { URL } = require('url');
  const incoming = new URL(req.url, serverBase);
  let pathname = incoming.pathname;

  if (pathname === '/') pathname = '/index.html';

  const normalized = path.normalize(pathname).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, normalized);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { handleStatic };
