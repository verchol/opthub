"""python3 cli.py [N] — print the monthly report for N sample entries."""
import sys

import ledger
import report

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    print(report.render(report.monthly(ledger.sample(n))))
