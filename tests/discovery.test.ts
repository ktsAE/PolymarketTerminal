import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
const {createDiscovery}=createRequire(import.meta.url)('../electron/discovery.cjs');
it('resolves only exact token matches and distinguishes unavailable/unresolved',async()=>{
 const calls:string[]=[];
 const d=createDiscovery({fetchJson:async(url:string)=>{calls.push(url);return [{id:'m',question:'Trusted',conditionId:'c',clobTokenIds:'["1","2"]',outcomes:'["Yes","No"]',orderPriceMinTickSize:0.01,orderMinSize:5,acceptingOrders:false,closed:true}];}});
 const results=await d.resolve({assetIds:['1','3']});expect(results.map((r:any)=>r.status)).toEqual(['UNAVAILABLE','UNRESOLVED']);expect(results[0].instrument.marketTitle).toBe('Trusted');expect(calls[0]).toContain('clob_token_ids=');
});
it('never invents tick/minimum metadata',async()=>{const d=createDiscovery({fetchJson:async()=>[{clobTokenIds:'["1"]',outcomes:'["Yes"]',acceptingOrders:true,closed:false}]});expect((await d.resolve({assetIds:['1']}))[0].status).toBe('UNRESOLVED');});
