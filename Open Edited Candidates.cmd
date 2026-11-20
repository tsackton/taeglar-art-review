@echo off
setlocal
py -3 -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>&1
if not errorlevel 1 goto use_py
python -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>&1
if not errorlevel 1 goto use_python
echo Install Python 3.9 or newer and reopen Art Review.
set "review_exit=1"
goto finish

:use_py
py -3 -u "%~dp0art_review.py" --edited %*
goto capture

:use_python
python -u "%~dp0art_review.py" --edited %*

:capture
set "review_exit=%errorlevel%"

:finish
if not "%review_exit%"=="0" pause
endlocal & exit /b %review_exit%
