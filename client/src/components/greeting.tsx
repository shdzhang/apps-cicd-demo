import { motion } from 'framer-motion';

export const Greeting = () => {
  return (
    <div
      key="overview"
      className='mx-auto mb-6 flex size-full max-w-3xl flex-col justify-center px-4'
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        className='text-center font-semibold text-lg md:text-xl'
      >
        What would you like to know?
      </motion.div>
    </div>
  );
};
