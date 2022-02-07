const fs = require('fs');

const package = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

delete package.scripts;
delete package.devDependencies;

fs.writeFileSync('./dist/package.json', JSON.stringify(package, null, 4));
fs.copyFileSync('./README.md', './dist/README.md');
