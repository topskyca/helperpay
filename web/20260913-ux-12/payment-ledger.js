/* Append-only correction/receipt events. Original payment facts and any
 * existing receipt acknowledgement are never overwritten by a correction. */
(function (global) {
  'use strict';
  const Legal = global.HSLegalModel || (typeof module !== 'undefined' ? require('./legal-model.js') : null);
  const copy = value => JSON.parse(JSON.stringify(value));
  const date = value => { try { return typeof value === 'string' && Legal.addDays(value, 0) === value; } catch { return false; } };
  const month = value => typeof value === 'string' && date(value + '-01');
  const methods = ['FPS', 'Bank transfer', 'Cash', 'Cheque', 'Other'];
  const facts = p => p ? { id:p.id, monthKey:p.monthKey, amount:p.amount, date:p.date, method:p.method, note:p.note || '',
    status:p.status, approval:p.approval || null, statementId:p.statementId || null,
    calculationBasis:p.calculationBasis || null, externalCalculationNote:p.externalCalculationNote || '' } : null;
  const valid = p => p && typeof p.id === 'string' && !!p.id && month(p.monthKey) && date(p.date) && Number.isFinite(p.amount) && p.amount > 0 &&
    Math.round(p.amount * 100) / 100 === p.amount && methods.includes(p.method) && ['paid','approved'].includes(p.status);
  const stamp = e => typeof e.id === 'string' && !!e.id && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at));

  function read(payment) {
    let effective = facts(payment), revisionId = null, pending = null;
    const events = payment?.paymentEvents ?? [];
    const bad = () => ({ effective:null, revisionId, pending, issue:'payment_history_invalid', events });
    if (!valid(effective) || !Array.isArray(events)) return bad();
    const ids = new Set();
    for (const event of events) {
      if (!event || !stamp(event) || ids.has(event.id)) return bad();
      ids.add(event.id);
      if (event.type === 'correction') {
        if (pending || event.previousRevisionId !== revisionId || event.beforeChecksum !== Legal.checksum(effective) ||
          typeof event.reason !== 'string' || !event.reason.trim() || !['replace','void'].includes(event.action) ||
          (event.action === 'void' ? event.after !== null : !valid(event.after) || event.after.status !== 'paid' || event.after.approval !== null || event.after.id !== payment.id)) return bad();
        const needsReview = effective?.status === 'approved' || (!effective && revisionId !== null);
        if (event.requiresHelperReview !== needsReview) return bad();
        if (needsReview) pending = { ...event, rejected:false };
        else { effective = copy(event.after); revisionId = event.id; }
      } else if (event.type === 'decision') {
        if (!pending || event.correctionId !== pending.id || !['accept','reject','withdraw'].includes(event.action)) return bad();
        if (event.action !== 'withdraw' && (typeof event.name !== 'string' || !event.name.trim() || typeof event.pinVerified !== 'boolean' || pending.rejected)) return bad();
        if (event.action === 'accept') {
          effective = pending.after && { ...copy(pending.after), status:'approved', approval:{ name:event.name, at:event.at, pinVerified:event.pinVerified, correctionId:pending.id } };
          revisionId = pending.id; pending = null;
        } else if (event.action === 'reject') pending = { ...pending, rejected:true };
        else pending = null;
      } else if (event.type === 'receipt') {
        if (pending || !effective || effective.status === 'approved' || event.revisionId !== revisionId || typeof event.name !== 'string' || !event.name.trim() || typeof event.pinVerified !== 'boolean') return bad();
        effective = { ...effective, status:'approved', approval:{name:event.name,at:event.at,pinVerified:event.pinVerified} };
      } else return bad();
    }
    return {effective,revisionId,pending,events,issue:null};
  }

  function propose(payment, input, meta) {
    const current = read(payment), errors = [];
    if (current.issue) return {errors:['history']};
    if (current.pending) return {errors:['pending']};
    if (!['replace','void'].includes(input.action)) errors.push('action');
    if (!String(input.reason || '').trim()) errors.push('reason');
    let after = null;
    if (input.action === 'replace') {
      after = {...(current.effective || facts(payment)), monthKey:input.monthKey,amount:Number(input.amount),date:input.date,
        method:input.method,note:String(input.note || '').trim(),status:'paid',approval:null};
      if (!month(after.monthKey)) errors.push('month');
      if (!date(after.date) || (meta.asOf && after.date > meta.asOf)) errors.push('date');
      if (input.amount === '' || !Number.isFinite(after.amount) || after.amount <= 0 || Math.round(after.amount*100)/100 !== after.amount) errors.push('amount');
      if (!methods.includes(after.method)) errors.push('method');
      if (current.effective && ['monthKey','amount','date','method','note'].every(key=>after[key]===current.effective[key])) errors.push('unchanged');
      // Reallocation does not claim this payment covers a statement in another month.
      if (after.monthKey !== current.effective?.monthKey) { after.statementId=null;after.calculationBasis='external';after.externalCalculationNote=String(input.reason || '').trim(); }
    } else if (!current.effective) errors.push('void');
    const event = {type:'correction',id:meta.id,at:meta.at,action:input.action,reason:String(input.reason || '').trim(),
      previousRevisionId:current.revisionId,beforeChecksum:Legal.checksum(current.effective),after,
      requiresHelperReview:current.effective?.status==='approved' || (!current.effective && current.revisionId!==null)};
    if (!stamp(event)) errors.push('metadata');
    if (errors.length) return {errors};
    const next={...payment,paymentEvents:[...copy(payment.paymentEvents || []),event]};
    if (read(next).issue) return {errors:['history']};
    return {errors:[],next};
  }

  function decide(payment, action, meta) {
    const current=read(payment);
    if (current.issue || !current.pending || (current.pending.rejected && action!=='withdraw')) return {errors:['pending']};
    const event={type:'decision',id:meta.id,at:meta.at,correctionId:current.pending.id,action,
      ...(action==='withdraw'?{}:{name:String(meta.name || '').trim(),pinVerified:meta.pinVerified===true})};
    const next={...payment,paymentEvents:[...copy(payment.paymentEvents || []),event]};
    return read(next).issue ? {errors:['decision']} : {errors:[],next};
  }

  function acknowledge(payment, meta) {
    const current=read(payment);
    if (current.issue || current.pending || !current.effective || current.effective.status==='approved') return {errors:['receipt']};
    const approval={name:String(meta.name || '').trim(),at:meta.at,pinVerified:meta.pinVerified===true};
    if (!approval.name || !Number.isFinite(Date.parse(approval.at))) return {errors:['receipt']};
    // Legacy first receipt remains compatible. Once history exists, append a
    // scoped acknowledgement; never replace the original receipt evidence.
    const next=payment.paymentEvents?.length ? {...payment,paymentEvents:[...copy(payment.paymentEvents),
      {type:'receipt',id:meta.id,revisionId:current.revisionId,...approval}]} : {...payment,status:'approved',approval};
    return read(next).issue ? {errors:['receipt']} : {errors:[],next};
  }

  function related(payment, key) {
    const current=read(payment);
    return !payment || !month(payment.monthKey) || payment.monthKey===key || current.effective?.monthKey===key || current.pending?.after?.monthKey===key ||
      (Array.isArray(payment.paymentEvents) && payment.paymentEvents.some(e=>e?.type==='correction' && e.after?.monthKey===key));
  }

  function summary(payments, key, asOf) {
    const source=Array.isArray(payments)?payments:[null];
    const rows=source.filter(p=>related(p,key)).map(payment=>({payment,...read(payment)}));
    for (const row of rows) if (row.payment && source.filter(p=>p?.id===row.payment.id).length>1) {
      row.effective=null;row.issue='payment_history_invalid';
    }
    const effective=rows.filter(r=>r.effective?.monthKey===key).map(r=>r.effective);
    const pending=rows.filter(r=>r.pending), invalid=rows.filter(r=>r.issue);
    const paid=effective.filter(p=>!asOf || p.date<=asOf).reduce((sum,p)=>sum+p.amount,0);
    return {rows,effective,pending,invalid,paid:Math.round(paid*100)/100,needsReview:pending.length>0 || invalid.length>0};
  }

  const api={facts,read,propose,decide,acknowledge,related,summary};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  global.HSPaymentLedger=api;
})(typeof window!=='undefined'?window:globalThis);
