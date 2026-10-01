// Public configuration only. NEVER put service_role / secret / payment secret keys here.
export const CONFIG = {
  SUPABASE_URL: 'https://cstwhhmjlthctxlmsqib.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_YLxdRBPcGtvIkNLlFh-fsQ_2LOnu-rF', // publishable (public) key
  PAYMENT_PUBLIC_KEY: '',                                              // e.g. Razorpay key_id (Phase 5)
  APP_NAME: 'SS_TECH_COMPUTER89',
  // Supabase Edge Function slug for Razorpay (the URL name shown in Supabase -> Edge Functions).
  RAZORPAY_FUNCTION: 'super-api',
  // Admin can type this username instead of an email on the normal login page.
  // The PASSWORD is NOT stored anywhere in the app: it lives (hashed) in Supabase Auth.
  ADMIN_USERNAME: 'Ss_tech_computer89',
  ADMIN_EMAIL: 'ss_tech_computer89@example.com'  // internal login id (example.com can never receive/steal reset mails)
};
