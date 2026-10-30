// Offline regression suite. No SDK import, credentials, account or network.
import assert from 'node:assert/strict';
import {buildOrderRequest} from '../electron/order-policy.cjs';
const metadata={tickSize:'0.01',minOrderSize:'5',acceptingOrders:true,closed:false};
const order={assetId:'1',side:'BUY',price:'0.50',size:'5',sizeUnit:'SHARES',execution:'GTC',mode:'LIVE'};
assert.deepEqual(buildOrderRequest(order,metadata).request,{assetId:'1',side:'BUY',price:'0.50',size:'5',postOnly:true});
assert.equal(buildOrderRequest({...order,execution:'FAK'},metadata).request.maxSpend,'2.5');
assert.equal(buildOrderRequest({...order,side:'SELL',execution:'FAK'},metadata).request.minPrice,'0.50');
assert.throws(()=>buildOrderRequest({...order,size:'100'},metadata),/notional/);
assert.throws(()=>buildOrderRequest({...order,price:'0.501'},metadata),/tick/);
assert.throws(()=>buildOrderRequest({...order,size:'1',sizeUnit:'USD'},metadata),/minimum/);
console.log('Offline trading policy checks passed');
