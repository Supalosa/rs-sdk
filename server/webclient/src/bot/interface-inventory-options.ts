import type {InterfaceOption} from '../../../../sdk/types';
interface Component {type?:number;hide?:boolean;children?:number[]|null;iop?:(string|null)[]|null;linkObjType?:ArrayLike<number>|null}
/** Item IDs in interface inventories are encoded as id + 1. */
export function inventoryInterfaceOptions(root:number,list:Component[],name:(id:number)=>string,startIndex=0):InterfaceOption[]{
 const options:InterfaceOption[]=[],seen=new Set<number>();
 function scan(id:number,depth:number){
  const com=list[id];if(depth>12||seen.has(id)||!com||(com.type===0&&com.hide))return;seen.add(id);
  if(com.type===2&&com.iop&&com.linkObjType){
   for(let slot=0;slot<com.linkObjType.length;slot++){
    const encoded=com.linkObjType[slot];if(!encoded||encoded<1)continue;const itemId=encoded-1;
    com.iop.forEach((operation,index)=>{if(!operation?.trim()||/^hidden$/i.test(operation))return;
     options.push({index:startIndex+options.length+1,text:`${operation} ${name(itemId)}`,componentId:id,slot,itemId,operationIndex:index+1});
    });
   }
  }
  for(const child of com.children??[])scan(child,depth+1);
 }
 scan(root,0);return options;
}
