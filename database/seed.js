const bcrypt = require('bcryptjs');
const db = require('./db');

function seedDemoUser() {
  const demoEmail = 'freelancerrafiq55@gmail.com';
  const demoName = 'Rafiqul Islam';
  const demoPass = '00000000';
  const demoMobile = '+8801700000000';

  const existing = db.prepare('SELECT id, email, full_name, role FROM users WHERE LOWER(email) = LOWER(?)').get(demoEmail);

  if (existing) {
    if (existing.role !== 'admin') {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      console.log(`[SEED] Updated demo user '${demoName}' to admin role.`);
    }
    return existing;
  }

  const saltRounds = 12;
  const passwordHash = bcrypt.hashSync(demoPass, saltRounds);

  const stmt = db.prepare(`
    INSERT INTO users (full_name, email, mobile_number, password_hash, role, email_verified, created_at, updated_at, last_login)
    VALUES (?, ?, ?, ?, 'admin', 1, datetime('now'), datetime('now'), NULL)
  `);

  const result = stmt.run(demoName, demoEmail, demoMobile, passwordHash);
  console.log(`[SEED] Demo user '${demoName}' successfully created in database with admin role (ID: ${result.lastInsertRowid})`);
  
  return { id: result.lastInsertRowid, email: demoEmail, full_name: demoName, role: 'admin' };
}

if (require.main === module) {
  seedDemoUser();
}

module.exports = { seedDemoUser };
