# Contributing to @model-action-protocol/core

Thanks for your interest in contributing to the Model Action Protocol.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ModelActionProtocol.git`
3. Install dependencies: `npm install`
4. Run tests: `npm test`

## Development

```bash
npm run dev    # Watch mode for TypeScript compilation
npm test       # Run the test suite
npm run build  # Build for production
```

## Pull Requests

- Create a feature branch from `main`
- Write tests for new functionality
- Ensure all tests pass before submitting
- Keep PRs focused — one feature or fix per PR
- Update the README if you're changing public API

## Reporting Issues

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js and TypeScript versions

## Code Style

- TypeScript strict mode
- Zod for runtime validation
- No external dependencies beyond `ai` and `zod`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
