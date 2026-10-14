# Third-party notices

API Anything core and its LinkedIn recipes are vendored from
https://github.com/goodnight000/api-anything at commit
`1788526eb54ff1f0d8bd7373bd5fdcac143ad7ad`, under the MIT license. The original
copyright notice and license are preserved in `vendor/api-anything/LICENSE`
and in the packed distribution. `vendor/api-anything/UPSTREAM.json` records
the source hashes and additive changes. No credentials were copied.

MetaHarness (`ruvnet/metaharness`, npm `metaharness@0.4.17`) is an MIT-licensed
harness factory. Generator provenance and generated harness configuration
are recorded under `.harness`. The application implements its own bounded
site tools over the generated scaffold; model providers and autonomous
evolution are not prerequisites for using the CLI or MCP server.

Other runtime dependencies retain their respective license files in their
installed npm packages. All direct dependencies are pinned in package.json;
the complete development installation is pinned in package-lock.json.
