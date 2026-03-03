build:
	bun run build

serve: build
	bunx serve dist

dev:
	bun run build && bunx serve dist

clean:
	rm -rf dist
