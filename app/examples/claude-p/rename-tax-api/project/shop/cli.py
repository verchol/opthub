import sys

from shop.tax import calc_tax as tax_for


def main(argv=None):
    amount, region = (argv or sys.argv[1:])[:2]
    print(f"{tax_for(float(amount), region):.2f}")


if __name__ == "__main__":
    main()
