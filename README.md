# BADR DUM Signing Automation

A modern Electron desktop application for automating BADR (Bureau d'Appui au Dédouanement) DUM (Déclaration d'Unité de Manifeste) signing process.

**Features:**

- ✅ Detect LTA Excel files with multiple DUMs
- ✅ Validate shipper names against BADR declarations
- ✅ Automate form filling and document signing
- ✅ Download and organize signed PDFs
- ✅ Real-time logging and progress tracking
- ✅ Modern React + Tailwind UI

---

## 📋 Prerequisites

Before installing this app, ensure you have:

### 1. **Node.js** (v18+)

- Download: https://nodejs.org/
- Verify installation:
  ```powershell
  node --version
  npm --version
  ```

### 2. **Microsoft Edge Browser** (with USB certificate profile loaded)

- Download: https://www.microsoft.com/en-us/edge
- **Must have your BADR USB certificate loaded in Edge for authentication**

### 3. **Git** (optional, for cloning)

- Download: https://git-scm.com/

---

## 🚀 Setup on a New Device

### Step 1: Clone the Repository

```powershell
git clone https://github.com/IsmailTAJANIELIDRISSI/badr-sign-app-copilot-2.git
cd badr-sign-app-copilot-2
```

### Step 2: Install Dependencies

```powershell
npm install
```

This installs:

- Node.js packages
- Electron (for desktop app)
- Playwright (for browser automation)
- React & Tailwind (for UI)
- All other dependencies

### Step 3: Create Environment File

Create a `.env` file in the project root:

```bash
# BADR Login
BADR_URL=https://badr.douane.gov.ma:40444/badr/Login
BADR_PASSWORD=your_badr_password_here

# Edge Browser
EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

# Automation Settings
BADR_CDP_PORT=9222
BADR_PROFILE_DIR=C:\Temp\badr-edge-profile
BADR_BUREAU_CODE=301
BADR_REGIME_CODE=010
BADR_YEAR=2026

# Application
PORT=3001
TIMEOUT=120000
NODE_ENV=development
HEADLESS=false
SLOW_MO=50

# Folder Configuration (optional - uses defaults if not specified)
DUMS_DIR=./dums
OUTPUTS_DIR=./outputs
LOGS_DIR=./logs
SIGNED_LTAS_DIR=./outputs
```

**⚠️ Important:** Never commit `.env` to Git (it's in `.gitignore`)

### Step 4: Create Required Folders

The app will auto-create these, but you can manually create them:

```powershell
# For development/testing
mkdir dums
mkdir outputs
mkdir logs
```

---

## 🎮 Running the App

### Option 1: Development Mode (Recommended for testing)

```powershell
npm run dev:electron
```

This will:

- Start Vite dev server on `http://localhost:5173`
- Launch Express API on `http://localhost:3001`
- Open Electron desktop window
- Enable hot reload for code changes

### Option 2: Web Browser Only (without Electron)

```powershell
npm run dev
```

Then visit: `http://localhost:5173`

---

## 📦 Building as Desktop App (.exe)

When ready to distribute to colleagues:

```powershell
npm run build:electron
```

This creates:

- **NSIS Installer**: `dist-electron/BADR-DUM-Signing-0.1.0.exe` (recommended)
- **Portable Executable**: `dist-electron/BADR-DUM-Signing-0.1.0-portable.exe` (no install)

Both files will be in the `dist-electron/` folder.

---

## 📂 Project Structure

```
badr-sign-app-copilot-2/
├── electron/                 # Electron main process & preload
│   ├── main.js              # Electron window management
│   └── preload.js           # IPC bridge for desktop features
├── server/                   # Backend API
│   ├── index.js             # Express server & routes
│   ├── automation.js        # BADR workflow automation
│   ├── badrConnection.js    # Edge + Playwright CDP
│   ├── excelParser.js       # Extract LTA/DUM from Excel
│   ├── config.js            # Configuration management
│   ├── state.js             # Job state & logging
│   └── logger.js            # Structured logging
├── src/                      # React UI
│   ├── App.jsx              # Main UI component
│   ├── main.jsx             # React entry point
│   └── main.css             # Tailwind imports
├── dums/                     # Input folder (Excel files)
├── outputs/                  # Signed PDF output folder (organized by LTA)
├── logs/                     # Application logs
├── package.json             # Dependencies
├── .env                      # Environment variables (not committed)
├── .env.example             # Environment template
└── .gitignore               # Git ignore rules
```

---

## 📖 How to Use the App

### 1. **Prepare Excel Files**

- Place your generated `LTA Excel files` in the `dums/` folder
- Example: `dums/generated_excel_235-97223803.xlsx`

### 2. **Start the App**

- Click "Refresh Files" to detect Excel files
- Detected LTAs appear as cards showing:
  - LTA reference number
  - Number of DUMs
  - Input field for expected shipper name

### 3. **Enter Shipper Information**

- For each LTA, type the exact shipper name as it appears in BADR
- This is verified against the actual declaration

### 4. **Run Signing Job**

- Select which LTAs to process (checkboxes)
- Click "Run Signing Job"
- Watch real-time logs as automation runs

### 5. **Monitor Progress**

- Live logs show each step:
  - Edge browser launch
  - Navigation to BADR
  - Form filling
  - Validation checks
  - Signing & printing
- Errors are logged with details

### 6. **Retrieve PDFs**

- Signed PDFs auto-save to: `outputs/LTA N° {REF}/DUM {N} LTA N°{REF}.pdf`
- Example: `outputs/LTA N°157-54440245/DUM 1 LTA N°157-54440245.pdf`
- Click "📁 Open Output PDFs" button to view folder

---

## 🔧 Troubleshooting

**For detailed troubleshooting including npm install errors, corrupted node_modules, and step-by-step fixes, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)**

### Quick Fixes

#### **Issue: npm install fails with "Cannot find module 'sumchecker'" or "EBUSY: resource busy"**

This is a corrupted node_modules issue. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the complete solution.

Quick fix:

```powershell
# Kill any running Node processes
Get-Process node | Stop-Process -Force

# Clean install
rm -r node_modules package-lock.json
npm cache clean --force
npm install
```

#### **Issue: "Module not found" errors**

```powershell
rm -r node_modules package-lock.json
npm install
```

#### **Issue: Edge browser not found**

Update the `EDGE_PATH` in `.env`:

```bash
# For 32-bit Edge
EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

# For 64-bit Edge
EDGE_PATH=C:\Program Files\Microsoft\Edge\Application\msedge.exe
```

#### **Issue: Excel files not detected**

1. Ensure files are in the `dums/` folder (or check the path displayed in the app banner)
2. Click "Refresh Files" button
3. Check that file extension is `.xlsx`, `.xls`, or `.xlsm`
4. Files must have LTA reference in cell A1

#### **Issue: BADR authentication fails**

1. Verify `BADR_PASSWORD` in `.env` is correct
2. Ensure Edge has your USB certificate profile loaded
3. Check BADR_URL is accessible from your network
4. Try manually logging into BADR in Edge first

#### **Issue: Certificate/USB key not recognized**

- Edge must have the profile with certificate already loaded
- Try manually logging into BADR first in Edge
- USB key must be plugged in before app starts
- Restart the app if certificate is inserted after startup

---

## 🎯 Typical Workflow

```
1. Clone repository
2. npm install
3. Create .env file
4. Place Excel LTA files in dums/ folder
5. npm run dev:electron
6. Refresh Files
7. Enter shipper names
8. Run Signing Job
9. Wait for completion
10. Check outputs/ folder for PDFs
```

---

## 📝 Environment Variables Explained

| Variable           | Purpose                       | Example                                                        |
| ------------------ | ----------------------------- | -------------------------------------------------------------- |
| `BADR_URL`         | BADR login URL                | `https://badr.douane.gov.ma:40444/badr/Login`                  |
| `BADR_PASSWORD`    | BADR password                 | `Med@2026`                                                     |
| `EDGE_PATH`        | Path to Edge executable       | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| `BADR_CDP_PORT`    | Chrome Debug Protocol port    | `9222`                                                         |
| `BADR_BUREAU_CODE` | Bureau code                   | `301`                                                          |
| `BADR_REGIME_CODE` | Regime code                   | `010`                                                          |
| `BADR_YEAR`        | Year for declarations         | `2026`                                                         |
| `PORT`             | API server port               | `3001`                                                         |
| `TIMEOUT`          | Automation timeout (ms)       | `120000`                                                       |
| `HEADLESS`         | Run Edge in headless mode     | `false`                                                        |
| `DUMS_DIR`         | Input folder for Excel files  | `./dums`                                                       |
| `OUTPUTS_DIR`      | Output folder for signed PDFs | `./outputs`                                                    |
| `LOGS_DIR`         | Application logs folder       | `./logs`                                                       |
| `SIGNED_LTAS_DIR`  | Output folder for signed PDFs | `./outputs`                                                    |

---

## 📞 Support

For issues or questions:

1. Check the logs in the `logs/` folder
2. Review error messages in the Live Run Logs panel
3. Check this README troubleshooting section

---

## 📄 License

Created for BADR automation purposes.

---

## ✅ Checklist for New Setup

- [ ] Node.js v18+ installed
- [ ] Microsoft Edge installed with certificate profile
- [ ] Repository cloned
- [ ] `npm install` completed
- [ ] `.env` file created with credentials
- [ ] `dums/` folder exists with Excel files
- [ ] `npm run dev:electron` runs without errors
- [ ] "Refresh Files" detects Excel files
- [ ] Shipper names entered
- [ ] "Run Signing Job" completes successfully
- [ ] PDFs appear in `outputs/` folder

---

**Good luck with your BADR automation!** 🚀
