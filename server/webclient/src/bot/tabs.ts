const names=['Combat','Skills','Quest journal','Inventory','Equipment','Prayer','Magic','Unused','Friends','Ignore','Logout','Settings','Player controls','Music'];
export interface TabClient {var?:number[];sideIcon:number[];activeIcon:number;tutFlashIcon?:number;tutComId?:number}
export function selectClientTab(c:TabClient,index:number,notify:(index:number)=>void){
 if(!Number.isInteger(index)||index<0||index>13||c.sideIcon[index]===undefined||c.sideIcon[index]===-1)return false;
 c.activeIcon=index;
 if(c.tutFlashIcon===index){c.tutFlashIcon=-1;notify(index);}
 return true;
}
export function collectTabs(c:TabClient,list:{children?:number[]|null;type?:number;text?:string|null}[]){
 const lines:string[]=[],seen=new Set<number>();
 function visit(id:number){if(seen.has(id)||!list[id])return;seen.add(id);const component=list[id];if(component.type===4&&component.text){const text=component.text.replace(/@[a-z0-9]{3}@/gi,'').replace(/\\n|\n|\|/g,' ').replace(/\s+/g,' ').trim();if(text)lines.push(text);}for(const child of component.children??[])visit(child);}
 if(c.tutComId!==undefined&&c.tutComId!==-1)visit(c.tutComId);
 return {...(c.var?.[173]!==undefined?{running:c.var[173]===1}:{}),active:c.activeIcon,flashing:c.tutFlashIcon!==undefined&&c.tutFlashIcon>=0?c.tutFlashIcon:null,available:(c.sideIcon??[]).flatMap((id,index)=>id!==-1?[{index,name:names[index]??`Tab ${index}`}]:[]),tutorialText:lines};
}
