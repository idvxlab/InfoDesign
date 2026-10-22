/** Serve exactly one local preview; never expose the source or data directory. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const file=resolve(process.argv[2]??'.local-data/preview-20261021.html');
const port=Number(process.argv[3]??8955);
const html=readFileSync(file);
createServer((req,res)=>{
  if(req.url!=='/'||req.method!=='GET'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(html);
}).listen(port,'127.0.0.1',()=>console.log('Preview http://127.0.0.1:'+port));
