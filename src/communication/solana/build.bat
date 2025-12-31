@echo off
REM Build script for Windows using MSVC
setlocal enabledelayedexpansion

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

echo Building AgenC Solana Communication Library...
echo Working directory: %CD%

REM Set up Visual Studio environment
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul 2>&1

if errorlevel 1 (
    echo Error: Could not find Visual Studio. Please install Visual Studio 2022 with C++ tools.
    exit /b 1
)

REM Create build directory
if not exist build mkdir build

REM Compiler flags - use C11 for stdatomic support
set CFLAGS=/nologo /W3 /O2 /MT /std:c11 /I"%SCRIPT_DIR%include" /D_CRT_SECURE_NO_WARNINGS /DWIN32 /D_WIN32_WINNT=0x0601 /experimental:c11atomics

echo Compiling source files...

REM Compile solana_status.c
echo   Compiling solana_status.c...
cl %CFLAGS% /c "%SCRIPT_DIR%src\solana_status.c" /Fo"build\solana_status.obj"
if errorlevel 1 goto :error

REM Compile solana_utils.c
echo   Compiling solana_utils.c...
cl %CFLAGS% /c "%SCRIPT_DIR%src\solana_utils.c" /Fo"build\solana_utils.obj"
if errorlevel 1 goto :error

REM Compile solana_rpc.c
echo   Compiling solana_rpc.c...
cl %CFLAGS% /c "%SCRIPT_DIR%src\solana_rpc.c" /Fo"build\solana_rpc.obj"
if errorlevel 1 goto :error

REM Compile solana_comm.c
echo   Compiling solana_comm.c...
cl %CFLAGS% /c "%SCRIPT_DIR%src\solana_comm.c" /Fo"build\solana_comm.obj"
if errorlevel 1 goto :error

REM Compile agenc_solana.c
echo   Compiling agenc_solana.c...
cl %CFLAGS% /c "%SCRIPT_DIR%src\agenc_solana.c" /Fo"build\agenc_solana.obj"
if errorlevel 1 goto :error

echo Creating static library...

REM Create static library
lib /nologo /out:build\solana_comm.lib build\*.obj
if errorlevel 1 goto :error

echo.
echo ========================================
echo Build successful!
echo Output: %SCRIPT_DIR%build\solana_comm.lib
echo ========================================
echo.

REM List the library
dir build\solana_comm.lib
exit /b 0

:error
echo.
echo Build failed!
exit /b 1
