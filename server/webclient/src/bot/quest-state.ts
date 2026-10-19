import {questTitleKey} from '../../../../sdk/quest-title';
import type {QuestState} from '../../../../sdk/types';
import progressVarps from './quest-progress.json';
interface Component {children?:number[]|null;text?:string|null;type?:number;buttonType?:number;colour?:number}
const clean=(text:string)=>text.replace(/@str@/g,'[done] ').replace(/@[a-z0-9]{3}@/gi,'').replace(/<\/?(?:col|str|br)[^>]*>/gi,'').trim();
function descendants(list:Component[],root:number){
 const ids:number[]=[],seen=new Set<number>();
 const visit=(id:number,depth:number)=>{if(depth>12||seen.has(id)||!list[id])return;seen.add(id);ids.push(id);for(const child of list[id]!.children??[])visit(child,depth+1);};visit(root,0);return ids;
}
/** Reads client-visible quest list colours, received progress vars and opened journal text only. */
export function collectQuestState(list:Component[],vars:number[],modal:number):QuestState {
 if(!list[638])return {available:false,entries:[]};
 const entries=descendants(list,638).filter(id=>list[id]?.buttonType===1&&list[id]?.text?.trim()).map(id=>{
  const component=list[id]!,colour=component.colour??0,r=(colour>>16)&255,g=(colour>>8)&255,b=colour&255;
  const status:QuestState['entries'][number]['status']=r>100&&g<100&&b<100?'not_started':g>100&&r<100&&b<100?'completed':r>100&&g>100&&b<100?'in_progress':'unknown';
  const varp=(progressVarps as Record<string,number>)[id];
  return {id,name:clean(component.text!),status,...(varp!==undefined&&Number.isInteger(vars[varp])?{progress:vars[varp]}:{})};
 });
 const result:QuestState={available:true,entries,...(Number.isInteger(vars[101])?{points:vars[101]}:{})};
 if(modal===8134){
  const title=clean(list[8144]?.text??'');
  const quest=entries.find(entry=>questTitleKey(entry.name)===questTitleKey(title));
  const lines=descendants(list,8143).filter(id=>id!==8144&&list[id]?.type===4&&!list[id]?.buttonType).map(id=>clean(list[id]?.text??'')).filter(Boolean);
  result.journal={questId:quest?.id,title,lines};
 }
 return result;
}
