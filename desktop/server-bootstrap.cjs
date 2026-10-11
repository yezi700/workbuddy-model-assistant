const {pathToFileURL}=require('node:url');
const path=require('node:path');
import(pathToFileURL(path.join(__dirname,'..','server.mjs')).href).catch(e=>{console.error(e);process.exit(1);});
