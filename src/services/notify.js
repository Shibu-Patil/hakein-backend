import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return transporter;
}

export async function sendEmail(to, subject, text, html) {
  const t = getTransporter();
  if (!t || !to) return false;
  try {
    await t.sendMail({
      from: `"Hakein Job Autopilot" <${process.env.GMAIL_USER}>`,
      to,
      subject: String(subject).slice(0, 120),
      text: String(text).slice(0, 4000),
      html: html || `<p>${String(text).slice(0, 4000).replace(/\n/g, '<br>')}</p>`
    });
    return true;
  } catch (e) {
    console.warn('[notify] email failed:', e.message);
    return false;
  }
}

// Free push via ntfy.sh — install ntfy app on phone, subscribe to topic, pops up even with our app closed.
export async function sendPush(topic, title, message) {
  if (!topic) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: String(title).slice(0, 100) },
      body: String(message).slice(0, 1000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Notify BOTH channels (whichever is configured). Reaches the phone even if our app is closed:
// Gmail app push for email, ntfy app push for topic.
export async function notifyUser(user, { subject, message }) {
  const prefs = user?.preferences || {};
  const emailTo = prefs.notifyEmail || user?.email;
  const topic = prefs.notifyTopic || process.env.NTFY_TOPIC;
  const [emailOk, pushOk] = await Promise.all([
    sendEmail(emailTo, subject, message),
    sendPush(topic, subject, message)
  ]);
  return { email: emailOk, push: pushOk };
}
