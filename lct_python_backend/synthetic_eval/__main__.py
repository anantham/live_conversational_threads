"""Allow ``python -m lct_python_backend.synthetic_eval`` to run the CLI."""

import sys

from lct_python_backend.synthetic_eval.run import main

if __name__ == "__main__":
    sys.exit(main())
