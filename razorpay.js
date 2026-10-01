// Shared Razorpay Checkout helper, used by checkout.js, builder.js and orders.js.
// Talks only to our own Supabase Edge Function ('razorpay') - the secret key never
// touches this file or any other frontend code.
import { sb } from './supabase.js';
import { esc } from './utils.js';
import { CONFIG } from './config.js';

let scriptPromise = null;
function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('RAZORPAY_SCRIPT_FAILED'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Opens Razorpay Checkout for an already-created SS_TECH order.
 * Resolves 'paid' | 'cancelled' | 'failed'. Never throws - callers just branch on the result.
 */
export async function payWithRazorpay(orderId, { name, phone, email, orderNumber, themeColor = '#2f7bff' } = {}) {
  try {
    await loadRazorpayScript();
    const { data: created, error: createErr } = await sb.functions.invoke(CONFIG.RAZORPAY_FUNCTION, { body: { action: 'create_order', order_id: orderId } });
    if (createErr || created?.error) throw createErr || new Error(created.error);

    return await new Promise(resolve => {
      const rzp = new window.Razorpay({
        key: created.key_id,
        amount: created.amount,
        currency: created.currency,
        name: 'SS_TECH_COMPUTER89',
        description: `Order ${orderNumber || created.order_number || ''}`,
        order_id: created.razorpay_order_id,
        prefill: { name: name || '', contact: phone || '', email: email || '' },
        theme: { color: themeColor },
        modal: { ondismiss: () => resolve('cancelled') },
        handler: async (resp) => {
          try {
            const { data: verified, error: verErr } = await sb.functions.invoke(CONFIG.RAZORPAY_FUNCTION, {
              body: {
                action: 'verify_payment', order_id: orderId,
                razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature
              }
            });
            resolve(!verErr && verified?.ok ? 'paid' : 'failed');
          } catch { resolve('failed'); }
        }
      });
      rzp.on('payment.failed', () => resolve('failed'));
      rzp.open();
    });
  } catch {
    return 'failed';
  }
}

export function razorpayUnavailableNote() {
  return `<p class="muted small">${esc('If the payment window does not open, please check your internet connection and try again.')}</p>`;
}
