@echo off
title APEX Library System
color 0A
echo.
echo  ========================================
echo   APEX Library Management System
echo  ========================================
echo.
cd /d %~dp0

if not exist node_modules (
    echo  Installing dependencies...
    echo  This may take a minute.
    echo.
    npm install
    echo.
)

echo  Starting servers...
echo.
node server.js

pause
