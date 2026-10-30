import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { buildOrderRequest }=createRequire(import.meta.url)('../electron/order-policy.cjs');
const d={assetId:'1',side:'BUY',price:'0.50',size:'5',sizeUnit:'SHARES',execution:'GTC',mode:'DRY'};
const m={tickSize:'0.01',minOrderSize:'5',acceptingOrders:true,closed:false};
it('exact ticks, precision, converted minimum and trusted metadata',()=>{
 expect(()=>buildOrderRequest({...d,price:'0.501'},m)).toThrow(/tick/i);
 expect(()=>buildOrderRequest({...d,size:'1',sizeUnit:'USD'},m)).toThrow(/minimum/i);
 expect(()=>buildOrderRequest({...d,price:'0.3',size:'2',sizeUnit:'USD'},m)).toThrow(/precision/i);
 expect(()=>buildOrderRequest(d,{...m,tickSize:''})).toThrow();
 expect(()=>buildOrderRequest({...d,size:'1e2'},m)).toThrow();
});
it('preserves postOnly and FAK bounded execution; DRY is not capped',()=>{
 expect(buildOrderRequest(d,m).request.postOnly).toBe(true);
 expect(buildOrderRequest({...d,execution:'FAK'},m).request).toMatchObject({maxPrice:'0.50',maxSpend:'2.5',orderType:'FAK'});
 expect(()=>buildOrderRequest({...d,size:'1000'},m)).not.toThrow();
 expect(()=>buildOrderRequest({...d,size:'1000',mode:'LIVE'},m)).toThrow(/notional/i);
});
