// Local simulation only: claim the account before game login, rather than
// discovering the headless session only after the engine rejects a duplicate.
let token:string|undefined,owner:string|undefined;
function endpoint(){
 if(typeof window==='undefined'||window.location.port!=='8888')return undefined;
 return `${window.location.protocol}//${window.location.hostname}:3030/client/headed`;
}
export async function claimBrowserControl(username:string):Promise<boolean>{
 const url=endpoint();if(!url)return true;
 try{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'claim',username}),signal:AbortSignal.timeout(9000)});
  if(!response.ok)return false;
  const result=await response.json();if(result.managed){token=result.token;owner=username;}
  return true;
 }catch{return true;} // The stock client still works when no local harness is running.
}
export function releaseBrowserControl(){
 const url=endpoint(),lease=token,username=owner;token=undefined;owner=undefined;
 if(!url||!lease||!username)return;
 void fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'release',username,token:lease}),keepalive:true}).catch(()=>{});
}
if(typeof window!=='undefined')window.addEventListener('pagehide',releaseBrowserControl);
