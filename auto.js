// routes/auto.js
const router = require('express').Router();
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth }    = require('../middleware/auth');
const tg          = require('../helpers/telegram');
const axios       = require('axios');

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzo5xiY3Tiqoz3Dh3XCADiA-jBNsGWTiIc_j1oGX6OOjOsU0wwNZHDG-DoQ8pcF_A72uw/exec';

router.post('/verify', auth, async (req, res) => {
  try {
    const { utr_or_famid, amount } = req.body;
    const amt = parseFloat(amount);

    if (!utr_or_famid) return res.status(400).json({ status:'error', message:'UTR or FamPay ID required' });
    if (!amt || amt < 1) return res.status(400).json({ status:'error', message:'Invalid amount' });

    const user = await User.findById(req.user._id);

    let gs;
    try {
      const { data } = await axios.get(SCRIPT_URL, {
        params:  { id: utr_or_famid },
        timeout: 15000
      });
      gs = data;
    } catch(e) {
      return res.status(500).json({ status:'error', message:'Verification server unreachable. Use manual submit.' });
    }

    if (gs.status === 'error') {
      return res.status(429).json({
        status:  'error',
        message: 'Verification server busy. Wait 1 minute and try again, or use manual submit.'
      });
    }

    if (gs.status === 'failed') {
      return res.status(400).json({
        status:  'error',
        message: gs.msg || 'ID not found in last 30 minutes. Pay karo pehle ya manual submit karo.'
      });
    }

    if (gs.status === 'success') {
      const verifiedAmt = parseFloat(gs.amount);
      const utrFromGs   = gs.utr && gs.utr !== 'none' ? gs.utr : null;
      const famId       = gs.txnId || null;

      // ✅ Duplicate check — application level pe
      const dupCheck = await Transaction.findOne({
        $or: [
          utrFromGs ? { utr_id: utrFromGs } : null,
          famId     ? { fam_id: famId }     : null,
        ].filter(Boolean)
      });
      if (dupCheck)
        return res.status(400).json({ status:'error', message:'Ye payment pehle se use ho chuki hai!' });

      if (verifiedAmt !== amt) {
        return res.status(400).json({
          status:  'error',
          message: `Amount mismatch! Payment ₹${verifiedAmt} ka hua, tune ₹${amt} enter kiya.`
        });
      }

      // ✅ null use karo empty string ki jagah
      const txn = await Transaction.create({
        receiver_id: user._id,
        amount:      verifiedAmt,
        type:        'transfer',
        status:      'success',
        dep_mode:    'auto',
        utr_id:      utrFromGs || null,
        fam_id:      famId     || null,
        remark:      `AUTO-DEPOSIT | ${famId || utrFromGs || utr_or_famid}`
      });

      await User.findByIdAndUpdate(user._id, { $inc: { balance: verifiedAmt } });

      const updated = await User.findById(user._id).select('balance tg_id mobile');

      if (updated?.tg_id) {
        tg.sendAlert(updated.tg_id,
`✅ *Deposit Successful*

━━━━━━━━━━━━━━
⚡  UNIO WALLET ✅
━━━━━━━━━━━━━━

💰 Amount  : ₹${verifiedAmt}
🔖 UTR     : \`${utrFromGs || 'N/A'}\`
🆔 FamID   : \`${famId     || 'N/A'}\`
📋 Txn ID  : \`${txn.tx_id}\`

━━━━━━━━━━━━━━
🪙 Balance : ₹${updated.balance}
━━━━━━━━━━━━━━

⚡ UNIO Auto Deposit`
        );
      }

      if (process.env.ADMIN_TG_ID) {
        tg.sendAlert(process.env.ADMIN_TG_ID,
`💳 *AUTO DEPOSIT SUCCESS*

👤 User   : \`${user.mobile}\`
💰 Amount : ₹${verifiedAmt}
🔖 UTR    : \`${utrFromGs || 'N/A'}\`
🆔 FamID  : \`${famId     || 'N/A'}\`
✅ Auto Credited

_UNIO Auto Deposit_`
        );
      }

      return res.json({
        status:  'success',
        message: `₹${verifiedAmt} wallet mein add ho gaya!`,
        tx_id:   txn.tx_id,
        amount:  verifiedAmt,
        utr:     utrFromGs,
        fam_id:  famId
      });
    }

    return res.status(400).json({ status:'error', message:'Unknown response from verification server.' });

  } catch(e) {
    console.error('Auto verify error:', e.message);
    res.status(500).json({ status:'error', message: e.message });
  }
});

module.exports = router;
