"""Standalone native macOS application entry point."""
import sys

if __name__ == '__main__':
    if '--panel-stdin' in sys.argv:
        from aibar.panel_mac import run_panel_from_file
        run_panel_from_file(sys.argv[sys.argv.index('--panel-stdin') + 1])
    else:
        from aibar.ui_mac import main
        main()
