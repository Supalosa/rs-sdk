import type {BotWorldState} from '../../../../sdk/types';
export interface HintClient {hintType?:number;hintNpc?:number;hintPlayer?:number;hintTileX?:number;hintTileZ?:number}
/** Decode the same server hint packet used by the rendered client. */
export function readHintArrow(c:HintClient,packet:{g1():number;g2():number}){
 const type=packet.g1();c.hintType=type;
 if(type===1)c.hintNpc=packet.g2();
 else if(type>=2&&type<=6){c.hintTileX=packet.g2();c.hintTileZ=packet.g2();packet.g1();c.hintType=2;}
 else if(type===10)c.hintPlayer=packet.g2();
}
export function collectHintArrow(c:HintClient):BotWorldState['hint']{
 if(c.hintType===1&&c.hintNpc!==undefined)return{type:'npc',index:c.hintNpc};
 if(c.hintType===10&&c.hintPlayer!==undefined)return{type:'player',index:c.hintPlayer};
 if(c.hintType!==undefined&&c.hintType>=2&&c.hintType<=6&&c.hintTileX!==undefined&&c.hintTileZ!==undefined)return{type:'tile',x:c.hintTileX,z:c.hintTileZ};
 return null;
}
