// Post-export step for the static web build (GitHub Pages / any static host):
//  - copies index.html to 404.html so deep links and refreshes fall back to
//    the app (GitHub Pages serves 404.html for unknown paths)
//  - writes an empty .nojekyll so GitHub Pages serves the `_expo/` asset
//    directory (Jekyll would skip underscore-prefixed paths otherwise)
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');

const indexPath = path.join(dist, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

fs.copyFileSync(indexPath, path.join(dist, '404.html'));
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
console.log('dist prepared (404.html, .nojekyll)');
