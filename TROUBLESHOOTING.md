# 🔧 Troubleshooting: npm install Errors

## Problem: "Cannot find module 'sumchecker'" & "EBUSY: resource busy"

This happens when node_modules is corrupted or locked. Here's the fix:

---

## ✅ Solution A: Clean Install (Recommended)

### Step 1: Kill any running Node processes

```powershell
# Windows PowerShell
Get-Process node | Stop-Process -Force
Get-Process npm | Stop-Process -Force
```

### Step 2: Delete corrupted node_modules

```powershell
# Navigate to your project
cd C:\sign

# Remove node_modules and lock files
rm -r node_modules
rm package-lock.json
```

### Step 3: Clear npm cache

```powershell
npm cache clean --force
```

### Step 4: Reinstall from scratch

```powershell
npm install
```

⏳ This will take 3-5 minutes on first run.

---

## ✅ Solution B: Quick Fix (If time is critical)

If you don't want to wait for full reinstall:

```powershell
# Just remove the problematic electron folder
rm -r node_modules\electron
rm -r node_modules\@electron

# Try installing again
npm install
```

---

## ✅ Solution C: Use npm ci (For fresh clones)

If you just cloned the repo:

```powershell
# Remove everything
rm -r node_modules
rm package-lock.json

# Use ci instead of install (installs exact versions from package-lock)
npm ci
```

---

## 🛡️ Prevention Tips

To avoid this in the future:

1. **Always close the app before reinstalling**

   ```powershell
   # Close any running npm dev servers
   # Press Ctrl+C in terminal
   ```

2. **Don't interrupt npm install**
   - Let it complete fully (even if it seems slow)
   - Don't close the terminal mid-installation

3. **Use a clean workspace**
   - Don't mix multiple npm projects in overlapping folders
   - Keep projects in separate directories

4. **Keep Node.js updated**
   ```powershell
   node --version  # Should be v18+
   ```

---

## 📋 Step-by-Step for Fresh PC

If you're on a completely fresh computer:

```powershell
# 1. Clone repo
git clone https://github.com/IsmailTAJANIELIDRISSI/badr-sign-app-copilot-2.git
cd badr-sign-app-copilot-2

# 2. Kill any existing Node processes
Get-Process node, npm | Stop-Process -Force -ErrorAction SilentlyContinue

# 3. Clear cache
npm cache clean --force

# 4. Install dependencies
npm install

# 5. Create .env file
# - Copy .env.example to .env
# - Fill in your BADR_PASSWORD

# 6. Run the app
npm run dev:electron
```

---

## 🆘 If It Still Fails

Run this diagnostic:

```powershell
# Check Node version
node --version

# Check npm version
npm --version

# List npm cache
npm cache verify

# Try installing specific package
npm install electron --save

# If that works, try full install
npm install
```

---

## 💡 Common Issues & Fixes

| Issue                            | Fix                                                                  |
| -------------------------------- | -------------------------------------------------------------------- |
| `EBUSY: resource busy`           | Kill Node processes: `Get-Process node \| Stop-Process -Force`       |
| `Cannot find module 'X'`         | Do clean install: `rm node_modules package-lock.json && npm install` |
| `npm ERR! code ERESOLVE`         | Try: `npm install --legacy-peer-deps`                                |
| `ERR! 404 Not Found`             | Check internet connection, try: `npm cache clean --force`            |
| `Module not found after install` | Run: `npm ci` instead of `npm install`                               |

---

## ✅ Success Indicators

After `npm install` completes successfully:

- No red error messages
- Terminal shows: `added XXX packages`
- `node_modules/` folder exists with thousands of files
- `package-lock.json` file is present

---

**Got it working? Great!** Now run:

```powershell
npm run dev:electron
```

**Still having issues?** Check:

1. Node.js version (should be v18+)
2. Internet connection (packages download during install)
3. Disk space (needs ~2GB for node_modules)
4. Antivirus (sometimes blocks npm operations)
