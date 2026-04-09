# 🚀 Setup Checklist for New Device

Follow these steps to get the BADR DUM Signing app running on a fresh machine:

---

## ✅ Phase 1: Prerequisites (5 minutes)

- [ ] **Install Node.js v18+**
  - Download from https://nodejs.org/
  - Run installer and follow instructions
  - Verify: `node --version` and `npm --version`

- [ ] **Install Microsoft Edge**
  - Download from https://www.microsoft.com/en-us/edge
  - **Important**: Load your BADR USB certificate profile before running the app

- [ ] **Install Git** (if cloning from GitHub)
  - Download from https://git-scm.com/
  - Or use GitHub Desktop

---

## ✅ Phase 2: Clone & Install (10 minutes)

- [ ] **Clone the repository**

  ```powershell
  git clone https://github.com/IsmailTAJANIELIDRISSI/badr-sign-app-copilot-2.git
  cd badr-sign-app-copilot-2
  ```

- [ ] **Install dependencies**
  ```powershell
  npm install
  ```
  ⏳ This takes 2-3 minutes on first run

---

## ✅ Phase 3: Configuration (5 minutes)

- [ ] **Create `.env` file**
  - Copy `.env.example` to `.env`
  - Fill in your credentials:
    ```
    BADR_PASSWORD=your_actual_password
    EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
    ```

- [ ] **Update EDGE_PATH if needed**
  - 32-bit: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  - 64-bit: `C:\Program Files\Microsoft\Edge\Application\msedge.exe`

- [ ] **Test `.env` is correct**
  ```powershell
  cat .env  # Should show your settings (not passwords!)
  ```

---

## ✅ Phase 4: Create Folders (2 minutes)

- [ ] **Create data folders** (auto-created on first run, but you can do it now)
  ```powershell
  mkdir dums
  mkdir outputs
  mkdir logs
  ```

---

## ✅ Phase 5: Run the App (2 minutes)

- [ ] **Start development mode**

  ```powershell
  npm run dev:electron
  ```

- [ ] **Wait for startup** (first time takes 20-30 seconds)
  - Browser will open showing "BADR DUM Signing Console"
  - Check terminal for `API listening on http://localhost:3001`

- [ ] **Verify app is running**
  - See "📂 DUMS FOLDER:" showing your folder path
  - See "Run Signing Job" button is visible

---

## ✅ Phase 6: Test the App (5 minutes)

- [ ] **Place test Excel file**
  - Add your LTA Excel file to the `dums/` folder
  - Example: `dums/generated_excel_235-97223803.xlsx`

- [ ] **Refresh files**
  - Click "Refresh Files" button
  - Should show LTA card with DUM count

- [ ] **Enter shipper name**
  - Type expected shipper name in the input field
  - This will be verified against BADR

- [ ] **Test a single DUM**
  - Select LTA checkbox
  - Click "Run Signing Job"
  - Watch logs appear in real-time
  - Check `outputs/` folder for signed PDF

---

## ✅ Phase 7: Optional - Build Executable (5 minutes)

When ready to distribute as `.exe` to colleagues:

- [ ] **Build the app**

  ```powershell
  npm run build:electron
  ```

  ⏳ Takes 2-3 minutes

- [ ] **Find installers in `dist-electron/` folder**
  - `BADR-DUM-Signing-0.1.0.exe` (requires installation)
  - `BADR-DUM-Signing-0.1.0-portable.exe` (no installation)

- [ ] **Share the `.exe` with colleagues**
  - They just need Node.js and Edge installed
  - Run the installer and it will work

---

## 🎯 Quick Commands Reference

```powershell
# Start development (with Electron desktop app)
npm run dev:electron

# Start development (web browser only)
npm run dev

# Build as standalone .exe
npm run build:electron

# View current configuration
cat .env

# Install again if issues
rm -r node_modules package-lock.json
npm install

# Check logs
cat logs/*.log
```

---

## ❌ Troubleshooting

### "Cannot find module..."

```powershell
npm install
```

### "BADR login fails"

1. Check `BADR_PASSWORD` in `.env` is correct
2. Ensure Edge has USB certificate loaded
3. Try logging in manually to BADR first

### "Excel files not detected"

1. Ensure files are in `dums/` folder
2. Click "Refresh Files"
3. Check file has `.xlsx` extension

### "Port 3001 already in use"

```powershell
# Find and kill the process
Get-Process | Where-Object {$_.Handles -eq 3001}
Stop-Process -Id <PID>
```

### "Slow startup"

- First run downloads Playwright browsers (~500MB)
- Subsequent runs are faster
- Check your internet connection

---

## 🎓 Learning Resources

- **React**: https://react.dev/
- **Electron**: https://www.electronjs.org/docs
- **Tailwind CSS**: https://tailwindcss.com/docs
- **Playwright**: https://playwright.dev/

---

## ✨ Tips for Smooth Setup

1. **Always use PowerShell (not cmd)** for commands
2. **Keep `.env` file private** - never share it
3. **Test with a single LTA first** before running large batches
4. **Check logs folder** if anything goes wrong
5. **Keep Node.js updated** for best compatibility

---

## 📞 Getting Help

If you encounter issues:

1. **Check the terminal** for error messages
2. **Look in `logs/` folder** for detailed logs
3. **Review this checklist** for common issues
4. **Check README.md** for more information

---

## ✅ Success Criteria

You're ready when:

- ✅ `npm run dev:electron` starts without errors
- ✅ App window opens showing "BADR DUM Signing Console"
- ✅ "Refresh Files" detects your Excel files
- ✅ You can enter shipper name and run a test job
- ✅ PDFs appear in `outputs/` folder

**Congratulations! You're all set up.** 🎉
